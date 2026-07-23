import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { logSecurityEventFromContext } from '../security/security-event';
import { getTenantId } from '../tenant/tenant-context';
import { env } from '../env';

const ALGO = 'aes-256-gcm';

/**
 * AES-256-GCM encryption for connector credentials at rest.
 *
 * Requires BADGERIQ_CONNECTOR_SECRET_KEY (32+ chars) — never falls back to the
 * JWT signing secret or a hardcoded default for *new* writes. A single compromise
 * of JWT must not decrypt connector credentials going forward.
 *
 * One-shot read migration: ciphertext encrypted under the historical JWT-derived
 * key (pre-Phase-3) is decrypted once, re-encrypted under the dedicated key, and
 * persisted. New stores always use the dedicated key only.
 */
@Injectable()
export class ConnectorSecretsService {
  private readonly logger = new Logger(ConnectorSecretsService.name);
  private readonly key: Buffer;
  /** Legacy JWT-derived key for one-time re-encrypt of pre-Phase-3 rows. */
  private readonly legacyJwtKey: Buffer | null;

  constructor(private readonly prisma: PrismaService) {
    const raw = env('BADGERIQ_CONNECTOR_SECRET_KEY');
    if (!raw || raw.length < 32) {
      throw new Error(
        'BADGERIQ_CONNECTOR_SECRET_KEY must be set to a random 32+ character string. ' +
          'Generate with: openssl rand -base64 32',
      );
    }
    this.key = createHash('sha256').update(raw).digest();

    const jwt = env('AGENTLEDGER_JWT_SECRET') || env('BADGERIQ_JWT_SECRET');
    this.legacyJwtKey =
      jwt && jwt.length >= 16 && jwt !== raw ? createHash('sha256').update(jwt).digest() : null;
  }

  private encryptWith(key: Buffer, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  private decryptWith(key: Buffer, ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  private encrypt(plaintext: string): string {
    return this.encryptWith(this.key, plaintext);
  }

  /**
   * Decrypt with the dedicated key; on auth failure try the legacy JWT-derived
   * key (pre-Phase-3 ciphertext). Caller should persist a re-encrypt when legacy
   * is used.
   */
  private decrypt(ciphertext: string): { plaintext: string; usedLegacy: boolean } {
    try {
      return { plaintext: this.decryptWith(this.key, ciphertext), usedLegacy: false };
    } catch (primaryErr) {
      if (!this.legacyJwtKey) throw primaryErr;
      try {
        return { plaintext: this.decryptWith(this.legacyJwtKey, ciphertext), usedLegacy: true };
      } catch {
        throw primaryErr;
      }
    }
  }

  async storeSecret(plaintext: string): Promise<string> {
    const tenantId = getTenantId();
    if (!tenantId) throw new Error('no tenant in context');
    const ciphertext = this.encrypt(plaintext);
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.connectorSecret.create({ data: { tenantId, ciphertext } }),
    );
    return row.secretId;
  }

  async resolveSecret(secretRef: string | null | undefined): Promise<string | undefined> {
    if (!secretRef) return undefined;
    const tenantId = getTenantId();
    if (!tenantId) return undefined;
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.connectorSecret.findUnique({ where: { secretId: secretRef } }),
    );
    if (!row) return undefined;
    // Audit decrypt/use only — never log ciphertext or plaintext.
    logSecurityEventFromContext('connector.secret_access', {
      secretId: secretRef,
      op: 'resolve',
    });
    const { plaintext, usedLegacy } = this.decrypt(row.ciphertext);
    if (usedLegacy) {
      const next = this.encrypt(plaintext);
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.connectorSecret.update({
          where: { secretId: secretRef },
          data: { ciphertext: next },
        }),
      );
      logSecurityEventFromContext('connector.secret_rekeyed', {
        secretId: secretRef,
        op: 'rekey_from_jwt',
      });
      this.logger.warn(`Re-encrypted connector secret ${secretRef} onto dedicated key`);
    }
    return plaintext;
  }

  async deleteSecret(secretRef: string): Promise<void> {
    const tenantId = getTenantId();
    if (!tenantId) return;
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.connectorSecret.deleteMany({ where: { secretId: secretRef } }),
    );
  }
}

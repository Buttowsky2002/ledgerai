import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { logSecurityEventFromContext } from '../security/security-event';
import { getTenantId } from '../tenant/tenant-context';
import { env } from '../env';

const ALGO = 'aes-256-gcm';

/**
 * AES-256-GCM encryption for connector credentials at rest.
 *
 * Requires BADGERIQ_CONNECTOR_SECRET_KEY (32+ chars) — never falls back to the
 * JWT signing secret or a hardcoded default. A single compromise of JWT must
 * not decrypt connector credentials.
 */
@Injectable()
export class ConnectorSecretsService {
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService) {
    const raw = env('BADGERIQ_CONNECTOR_SECRET_KEY');
    if (!raw || raw.length < 32) {
      throw new Error(
        'BADGERIQ_CONNECTOR_SECRET_KEY must be set to a random 32+ character string. ' +
          'Generate with: openssl rand -base64 32',
      );
    }
    this.key = createHash('sha256').update(raw).digest();
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  private decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
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
    return this.decrypt(row.ciphertext);
  }

  async deleteSecret(secretRef: string): Promise<void> {
    const tenantId = getTenantId();
    if (!tenantId) return;
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.connectorSecret.deleteMany({ where: { secretId: secretRef } }),
    );
  }
}

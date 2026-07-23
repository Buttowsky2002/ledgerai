import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { recordAudit } from '../common/audit';
import { Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';

/** SHA-256 hex — mirrors the gateway's sha256hex (keys.go) so minted keys authenticate. */
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Plaintext virtual key: `alk_` + 48 lowercase hex chars (24 random bytes). */
function generateKey(): string {
  return `alk_${randomBytes(24).toString('hex')}`;
}

export interface CreateVirtualKey {
  name: string;
  teamId?: string;
  userId?: string;
  appId?: string;
  environment?: string;
  allowedModels?: string[];
  monthlyBudgetUsd?: number;
  rateLimitRpm?: number;
  dlpPolicyId?: string;
}

export type UpdateVirtualKey = Partial<Omit<CreateVirtualKey, 'teamId' | 'userId' | 'appId'>>;

@Injectable()
export class VirtualKeysService {
  constructor(private readonly prisma: PrismaService) {}

  /** Strip the secret hash from any response — it is never returned, only the
   *  plaintext at creation time (once). */
  private sanitize(row: Record<string, unknown>): Record<string, unknown> {
    const rest = { ...row };
    delete rest.keyHash;
    return rest;
  }

  list(page: Page) {
    return this.prisma
      .withTenant(getTenantId(), (tx) =>
        tx.virtualKey.findMany({ take: page.limit, skip: page.offset, orderBy: { keyId: 'asc' } }),
      )
      .then((rows) => rows.map((r) => this.sanitize(r)));
  }

  async get(id: string) {
    const tenantId = getTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.virtualKey.findFirst({ where: { keyId: id, ...(tenantId ? { tenantId } : {}) } }),
    );
    if (!row) {
      throw new NotFoundException('virtual_key not found');
    }
    return this.sanitize(row);
  }

  /** Mint a key: returns the plaintext exactly once; stores only its SHA-256 hash. */
  async create(dto: CreateVirtualKey) {
    const plaintext = generateKey();
    const keyHash = sha256hex(plaintext);
    const created = await this.prisma.withTenant(getTenantId(), async (tx) => {
      const row = await tx.virtualKey.create({
        data: {
          tenantId: getTenantId() as string,
          keyHash,
          name: dto.name,
          teamId: dto.teamId,
          userId: dto.userId,
          appId: dto.appId,
          environment: dto.environment,
          allowedModels: dto.allowedModels ?? [],
          monthlyBudgetUsd: dto.monthlyBudgetUsd as unknown as Prisma.Decimal | undefined,
          rateLimitRpm: dto.rateLimitRpm,
          dlpPolicyId: dto.dlpPolicyId,
        },
      });
      // Audit records the hash-free row — never the plaintext or the hash.
      await recordAudit(tx, {
        action: 'create',
        object: `virtual_key:${row.keyId}`,
        before: null,
        after: this.sanitize(row),
      });
      return row;
    });
    // Plaintext shown exactly once (security rule 6).
    return { ...this.sanitize(created), key: plaintext };
  }

  async update(id: string, dto: UpdateVirtualKey) {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const tenantId = getTenantId();
      const before = await tx.virtualKey.findFirst({
        where: { keyId: id, ...(tenantId ? { tenantId } : {}) },
      });
      if (!before) {
        throw new NotFoundException('virtual_key not found');
      }
      const after = await tx.virtualKey.update({
        where: { keyId: id },
        data: {
          name: dto.name,
          environment: dto.environment,
          allowedModels: dto.allowedModels,
          monthlyBudgetUsd: dto.monthlyBudgetUsd as unknown as Prisma.Decimal | undefined,
          rateLimitRpm: dto.rateLimitRpm,
          dlpPolicyId: dto.dlpPolicyId,
        },
      });
      await recordAudit(tx, {
        action: 'update',
        object: `virtual_key:${id}`,
        before: this.sanitize(before),
        after: this.sanitize(after),
      });
      return this.sanitize(after);
    });
  }

  /** Revoke (soft delete): set revoked_at; the key stops authenticating at the gateway. */
  async revoke(id: string) {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const tenantId = getTenantId();
      const before = await tx.virtualKey.findFirst({
        where: { keyId: id, ...(tenantId ? { tenantId } : {}) },
      });
      if (!before) {
        throw new NotFoundException('virtual_key not found');
      }
      const after = await tx.virtualKey.update({
        where: { keyId: id },
        data: { revokedAt: new Date() },
      });
      await recordAudit(tx, {
        action: 'delete',
        object: `virtual_key:${id}`,
        before: this.sanitize(before),
        after: this.sanitize(after),
      });
      return { revoked: true };
    });
  }
}

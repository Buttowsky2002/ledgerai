import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Logger, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { recordAudit } from '../common/audit';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';

class IssueCredentialDto {
  @IsUUID() agentId!: string;
  @IsString() name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(8760) ttlHours?: number; // default 24h; max 1y
}

class RevokeDto {
  @IsOptional() @IsString() reason?: string;
}

class DecommissionDto {
  @IsOptional() @IsInt() @Min(1) @Max(3650) dormantDays?: number; // default 30
}

interface CredentialRow {
  credentialId: string;
  tenantId: string;
  agentId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  status: string;
  expiresAt: Date | null;
  [k: string]: unknown;
}

/**
 * Non-human identity (NHI) credential governance (Phase 6, deferred from P5).
 * Postgres is the source of truth (RLS + audit, migration 007). Credentials are
 * issued in "pending" state with a short TTL, approved into "active", and revoked
 * manually or via dormant-agent decommissioning. The secret is returned exactly
 * once at issuance; only its SHA-256 hash is stored (security rule 6). The
 * blast-radius view joins active credentials with the tool allowlist (006).
 */
@Controller('v1/agent-credentials')
export class AgentCredentialsController {
  private readonly logger = new Logger(AgentCredentialsController.name);
  private readonly crud: CrudService;
  constructor(private readonly prisma: PrismaService) {
    this.crud = new CrudService(prisma, {
      model: 'agentCredential',
      idField: 'credentialId',
      object: 'agent_credential',
    });
  }

  @Roles('viewer') @Get()
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const rows = (await this.crud.list(parsePagination(limit, offset))) as CredentialRow[];
    return rows.map(sanitize);
  }

  /**
   * Issue a credential. Generates a one-time secret, stores only its hash, and
   * returns the plaintext token exactly once. Created "pending" — not usable
   * until approved. analyst+ may request issuance.
   */
  @Roles('analyst') @Post()
  async issue(@Body() dto: IssueCredentialDto) {
    const token = 'agc_' + randomBytes(24).toString('base64url');
    const tokenHash = sha256(token);
    const ttlHours = dto.ttlHours ?? 24;
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    const created = (await this.crud.create({
      agentId: dto.agentId,
      name: dto.name,
      tokenHash,
      scopes: dto.scopes ?? [],
      status: 'pending',
      expiresAt,
    })) as CredentialRow;
    // Plaintext token is surfaced here and never again.
    return { credential: sanitize(created), token };
  }

  /** Approve a pending credential into active (admin only). */
  @Roles('admin') @Post(':id/approve')
  async approve(@Param('id') id: string) {
    const before = (await this.crud.get(id)) as CredentialRow; // 404s cross-tenant under RLS
    if (before.status !== 'pending') {
      throw new BadRequestException(`credential is ${before.status}, not pending`);
    }
    const approvedBy = getPrincipal()?.userId ?? 'system';
    const after = (await this.crud.update(id, {
      status: 'active',
      approvedBy,
      approvedAt: new Date(),
    })) as CredentialRow;
    return sanitize(after);
  }

  /** Revoke a credential (admin only). */
  @Roles('admin') @Post(':id/revoke')
  async revoke(@Param('id') id: string, @Body() dto: RevokeDto) {
    await this.crud.get(id); // 404s cross-tenant under RLS
    const after = (await this.crud.update(id, {
      status: 'revoked',
      revokedAt: new Date(),
      revokedReason: dto.reason ?? 'manual',
    })) as CredentialRow;
    return sanitize(after);
  }

  /**
   * Blast radius per agent: active credential count, total credentials, and
   * allowlisted tool count. RLS confines all three joined tables to the tenant.
   */
  @Roles('viewer') @Get('blast-radius')
  blastRadius() {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          agentId: string;
          agentName: string;
          approvalStatus: string;
          decommissionedAt: Date | null;
          activeCredentials: bigint;
          totalCredentials: bigint;
          allowlistedTools: bigint;
        }>
      >(`
        SELECT a.agent_id AS "agentId", a.name AS "agentName",
               a.approval_status AS "approvalStatus", a.decommissioned_at AS "decommissionedAt",
               count(c.credential_id) FILTER (
                 WHERE c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())
               ) AS "activeCredentials",
               count(c.credential_id) AS "totalCredentials",
               (SELECT count(*) FROM agent_tool_allowlist al WHERE al.agent_id = a.agent_id) AS "allowlistedTools"
        FROM agents a
        LEFT JOIN agent_credentials c ON c.agent_id = a.agent_id AND c.tenant_id = a.tenant_id
        GROUP BY a.agent_id, a.name, a.approval_status, a.decommissioned_at
        ORDER BY "activeCredentials" DESC, "allowlistedTools" DESC
      `);
      return rows.map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        approvalStatus: r.approvalStatus,
        decommissionedAt: r.decommissionedAt,
        activeCredentials: Number(r.activeCredentials),
        totalCredentials: Number(r.totalCredentials),
        allowlistedTools: Number(r.allowlistedTools),
      }));
    });
  }

  /**
   * Decommission dormant agents: revoke active credentials unused for longer than
   * dormantDays (default 30) and mark their agents decommissioned. Admin only.
   */
  @Roles('admin') @Post('decommission-dormant')
  async decommissionDormant(@Body() dto: DecommissionDto) {
    const days = dto.dormantDays ?? 30;
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      // Dormant = active credential whose effective last use (last_used_at, else
      // created_at) is older than the cutoff. The typed client keeps this RLS-safe.
      const dormant = await tx.agentCredential.findMany({
        where: {
          status: 'active',
          OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }],
        },
        select: { credentialId: true, agentId: true },
      });

      if (dormant.length === 0) {
        return { decommissionedAgents: 0 };
      }
      const credIds = dormant.map((c) => c.credentialId);
      const agentIds = [...new Set(dormant.map((c) => c.agentId))];

      await tx.agentCredential.updateMany({
        where: { credentialId: { in: credIds } },
        data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'dormant' },
      });
      const res = await tx.agent.updateMany({
        where: { agentId: { in: agentIds }, decommissionedAt: null },
        data: { decommissionedAt: new Date() },
      });

      await recordAudit(tx, {
        action: 'update',
        object: `agent_credential:decommission-dormant:${days}d`,
        before: null,
        after: { decommissionedAgents: res.count, revokedCredentials: credIds.length },
      });
      this.logger.log(`dormant decommission: ${res.count} agents, ${credIds.length} creds (>${days}d)`);
      return { decommissionedAgents: res.count };
    });
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Never return the token hash (defense in depth — it's a hash, not the secret).
function sanitize(row: CredentialRow): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  delete copy.tokenHash;
  return copy;
}

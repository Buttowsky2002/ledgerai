import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getRequestClientMeta, logSecurityEvent } from '../security/security-event';
import { AccessClaims, JwtService } from './jwt.service';

interface IdentityRow {
  user_id: string;
  tenant_id: string;
  api_role: string;
}

/** A per-tenant IdP resolved by email domain (P6-D1 SSO). */
export interface IdpRow {
  tenant_id: string;
  idp_id: string;
  issuer: string;
  client_id: string;
  client_secret_ref: string;
  jit_enabled: boolean;
  default_api_role: string;
}

interface ScopedIdentityRow {
  user_id: string;
  api_role: string;
  active: boolean;
}

/**
 * Turns a verified SSO email into session tokens. The email→identity lookup goes
 * through the auth_lookup_identity() SECURITY DEFINER function (migration 003) —
 * the one controlled RLS bypass — because no tenant is bound yet at login. Unknown
 * emails are rejected (no auto-provisioning in this task).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async loginByEmail(email: string): Promise<{ accessToken: string; refreshToken: string; claims: AccessClaims }> {
    // Parameterised ($1) — never string-concatenated (rule 4).
    const rows = await this.prisma.$queryRaw<IdentityRow[]>`
      SELECT user_id, tenant_id, api_role FROM auth_lookup_identity(${email})`;
    if (rows.length === 0) {
      this.auditAuthFailure(null, null, 'no_identity');
      throw new UnauthorizedException('no identity provisioned for this email');
    }
    const claims: AccessClaims = {
      userId: rows[0].user_id,
      tenantId: rows[0].tenant_id,
      role: rows[0].api_role,
    };
    this.auditAuthSuccess('auth.login_success', claims);
    return {
      accessToken: await this.jwt.mintAccess(claims),
      refreshToken: await this.jwt.mintRefresh(claims),
      claims,
    };
  }

  /**
   * Remint access from a refresh token. Re-reads `api_role` (and active) from the
   * identity row so Settings role changes take effect on the next access-token
   * refresh (~15m) without requiring a full SSO round-trip.
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; claims: AccessClaims }> {
    let prior: AccessClaims;
    try {
      prior = await this.jwt.verifyRefresh(refreshToken);
    } catch {
      this.auditAuthFailure(null, null, 'invalid_refresh');
      throw new UnauthorizedException('invalid refresh token');
    }
    const row = await this.prisma.withTenant(prior.tenantId, (tx) =>
      tx.identity.findUnique({
        where: { userId: prior.userId },
        select: { apiRole: true, active: true },
      }),
    );
    if (!row || !row.active) {
      this.auditAuthFailure(prior.tenantId, prior.userId, 'identity_inactive');
      throw new UnauthorizedException('identity inactive or missing');
    }
    const claims: AccessClaims = {
      userId: prior.userId,
      tenantId: prior.tenantId,
      role: row.apiRole,
    };
    this.auditAuthSuccess('auth.token_refresh', claims);
    return { accessToken: await this.jwt.mintAccess(claims), claims };
  }

  /**
   * Resolve a login email's domain to the tenant IdP that handles it, via the
   * idp_lookup_by_domain() SECURITY DEFINER function (migration 008) — no tenant
   * is bound yet at login, so this is the sanctioned RLS bypass.
   */
  async lookupIdpByDomain(domain: string): Promise<IdpRow | null> {
    const rows = await this.prisma.$queryRaw<IdpRow[]>`
      SELECT tenant_id, idp_id, issuer, client_id, client_secret_ref, jit_enabled, default_api_role
      FROM idp_lookup_by_domain(${domain.toLowerCase()})`;
    return rows[0] ?? null;
  }

  /**
   * Re-read a tenant IdP by id for the callback. The tenant comes from the signed
   * oidc_tx cookie (trusted), so this is an ordinary RLS-scoped read (no bypass) —
   * and it works on a replica that never handled the matching /sso/login.
   */
  async getTenantIdp(tenantId: string, idpId: string): Promise<IdpRow | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantIdpConfig.findUnique({ where: { idpId } }),
    );
    if (!row || !row.enabled) {
      return null;
    }
    return {
      tenant_id: row.tenantId,
      idp_id: row.idpId,
      issuer: row.issuer,
      client_id: row.clientId,
      client_secret_ref: row.clientSecretRef,
      jit_enabled: row.jitEnabled,
      default_api_role: row.defaultApiRole,
    };
  }

  /**
   * Turn a verified SSO identity into session tokens, provisioning it on first
   * login when the tenant's IdP allows JIT. Tenant-scoped (the same email may
   * exist in multiple tenants once each has its own IdP). A deactivated identity
   * is refused; a brand-new one is created with source = the IdP provider.
   */
  async provisionAndLogin(opts: {
    tenantId: string;
    email: string;
    sub: string;
    source: string;
    jitEnabled: boolean;
    defaultApiRole: string;
  }): Promise<{ accessToken: string; refreshToken: string; claims: AccessClaims }> {
    const found = await this.lookupInTenant(opts.tenantId, opts.email);
    let userId: string;
    let apiRole: string;

    if (found) {
      if (!found.active) {
        this.auditAuthFailure(opts.tenantId, found.user_id, 'identity_deactivated');
        throw new UnauthorizedException('identity deactivated');
      }
      userId = found.user_id;
      apiRole = found.api_role;
    } else {
      if (!opts.jitEnabled) {
        this.auditAuthFailure(opts.tenantId, null, 'no_identity');
        throw new UnauthorizedException('no identity provisioned for this email');
      }
      const created = await this.prisma.$queryRaw<{ user_id: string; api_role: string }[]>`
        SELECT user_id, api_role FROM auth_provision_identity(
          ${opts.tenantId}::uuid, ${opts.email}, ${opts.sub}, ${opts.source}, ${opts.defaultApiRole})`;
      if (created.length === 0) {
        // Lost a provisioning race (ON CONFLICT DO NOTHING) — re-resolve.
        const reread = await this.lookupInTenant(opts.tenantId, opts.email);
        if (!reread || !reread.active) {
          this.auditAuthFailure(opts.tenantId, null, 'identity_unavailable');
          throw new UnauthorizedException('identity unavailable');
        }
        userId = reread.user_id;
        apiRole = reread.api_role;
      } else {
        userId = created[0].user_id;
        apiRole = created[0].api_role;
        await this.auditProvision(opts.tenantId, userId, opts.email, opts.source);
      }
    }

    const claims: AccessClaims = { userId, tenantId: opts.tenantId, role: apiRole };
    this.auditAuthSuccess('auth.login_success', claims);
    return {
      accessToken: await this.jwt.mintAccess(claims),
      refreshToken: await this.jwt.mintRefresh(claims),
      claims,
    };
  }

  private async lookupInTenant(tenantId: string, email: string): Promise<ScopedIdentityRow | null> {
    const rows = await this.prisma.$queryRaw<ScopedIdentityRow[]>`
      SELECT user_id, api_role, active
      FROM auth_lookup_identity_in_tenant(${tenantId}::uuid, ${email})`;
    return rows[0] ?? null;
  }

  // Audit the JIT provisioning (rule 10). There is no request principal at login,
  // so the row is written inside an explicit tenant-bound transaction (sets
  // app.tenant_id → RLS WITH CHECK passes) with the IdP as the actor.
  private async auditProvision(tenantId: string, userId: string, email: string, source: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actor: `sso:${source}`,
          action: 'create',
          object: `identity:${userId}`,
          detail: { before: null, after: { email, source, jit: true } },
        },
      }),
    );
  }

  private auditAuthSuccess(
    type: 'auth.login_success' | 'auth.token_refresh',
    claims: AccessClaims,
  ): void {
    const meta = getRequestClientMeta();
    logSecurityEvent({
      type,
      tenantId: claims.tenantId,
      userId: claims.userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private auditAuthFailure(tenantId: string | null, userId: string | null, reason: string): void {
    const meta = getRequestClientMeta();
    logSecurityEvent({
      type: 'auth.login_failure',
      tenantId,
      userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: { reason },
    });
  }
}

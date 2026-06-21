import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { scimError } from './scim.types';

/** Request augmented with the SCIM tenant resolved from the bearer token. */
export interface ScimRequest extends Request {
  scim?: { tenantId: string; tokenId: string };
}

/**
 * Authenticates SCIM requests with a per-tenant bearer token (scim_…). The token
 * is resolved to its tenant via the scim_token_resolve() SECURITY DEFINER function
 * (migration 009) — the SCIM auth has no tenant context yet, so this is the
 * sanctioned RLS bypass, mirroring the SSO login lookups. The resolved tenant is
 * attached to the request; SCIM handlers pass it explicitly to withTenant(), so
 * every downstream query is RLS-confined to that tenant.
 *
 * SCIM routes are @Public to the JWT AuthGuard and carry this guard instead.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ScimRequest>();
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      throw new HttpException(scimError(401, 'missing or malformed SCIM bearer token'), 401);
    }
    const hash = createHash('sha256').update(auth.slice(7).trim()).digest('hex');
    const rows = await this.prisma.$queryRaw<{ tenant_id: string; token_id: string }[]>`
      SELECT tenant_id, token_id FROM scim_token_resolve(${hash})`;
    if (rows.length === 0) {
      throw new HttpException(scimError(401, 'invalid or revoked SCIM token'), 401);
    }
    req.scim = { tenantId: rows[0].tenant_id, tokenId: rows[0].token_id };
    return true;
  }
}

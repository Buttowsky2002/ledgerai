import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env';
import { PrismaService } from '../prisma/prisma.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';
import { CreateInviteDto } from './invites.dto';

/**
 * Token convention:
 *   raw  = 20 random bytes → 40 hex chars (sent in the invite email link)
 *   hash = SHA-256(raw)    → stored in DB (token_hash column)
 * The raw token is never stored; the DB only stores the hash.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(20).toString('hex'); // 40 chars
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function inviteLink(rawToken: string): string {
  const base = env('BADGERIQ_DASHBOARD_URL') ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/invite/accept?token=${rawToken}`;
}

@Injectable()
export class InvitesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin: create a pending invite and return the raw token for email delivery. */
  async create(dto: CreateInviteDto): Promise<{ inviteId: string; link: string }> {
    const tenantId = getTenantId();
    const principal = getPrincipal();
    if (!tenantId || !principal?.userId) {
      throw new BadRequestException('no tenant context');
    }

    const { raw, hash } = generateInviteToken();
    const email = dto.email.toLowerCase();

    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM invites
        WHERE tenant_id = ${tenantId}::uuid
          AND email = ${email}
          AND status = 'pending'
          AND expires_at > now()`,
    );
    if ((existing[0]?.count ?? 0) > 0) {
      throw new BadRequestException(
        'A pending invite already exists for this email. Revoke it first.',
      );
    }

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<{ invite_id: string }[]>`
        INSERT INTO invites (tenant_id, email, api_role, token_hash, invited_by)
        VALUES (
          ${tenantId}::uuid,
          ${email},
          ${dto.apiRole},
          ${hash},
          ${principal.userId}::uuid
        )
        RETURNING invite_id`,
    );

    return { inviteId: rows[0].invite_id, link: inviteLink(raw) };
  }

  /** Admin: list all invites for the tenant (most recent first). */
  async list(): Promise<unknown[]> {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant context');

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw`
        SELECT i.invite_id AS "inviteId",
               i.email,
               i.api_role AS "apiRole",
               i.status,
               i.expires_at AS "expiresAt",
               i.accepted_at AS "acceptedAt",
               i.display_name AS "displayName",
               ident.display_name AS "invitedByName"
        FROM   invites i
        LEFT JOIN identities ident ON ident.user_id = i.invited_by
        WHERE  i.tenant_id = ${tenantId}::uuid
        ORDER  BY i.created_at DESC
        LIMIT  200`,
    );
  }

  /** Admin: revoke a pending invite. */
  async revoke(inviteId: string): Promise<void> {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant context');

    const result = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRaw`
        UPDATE invites
           SET status = 'revoked'
         WHERE invite_id = ${inviteId}::uuid
           AND tenant_id = ${tenantId}::uuid
           AND status    = 'pending'`,
    );
    if (result === 0) throw new NotFoundException('invite not found or not pending');
  }

  /**
   * Public: resolve a raw token to its invite metadata (for the accept page).
   * Uses the SECURITY DEFINER function — no tenant is bound at this point.
   */
  async resolve(rawToken: string): Promise<{
    inviteId: string;
    email: string;
    apiRole: string;
    expiresAt: Date;
  }> {
    if (!rawToken || rawToken.length < 40) throw new BadRequestException('invalid token');

    const rows = await this.prisma.$queryRaw<
      { invite_id: string; email: string; api_role: string; expires_at: Date }[]
    >`SELECT invite_id, email, api_role, expires_at FROM invite_lookup_by_token(${rawToken})`;

    if (rows.length === 0) {
      throw new NotFoundException('invite not found, already used, or expired');
    }
    return {
      inviteId: rows[0].invite_id,
      email: rows[0].email,
      apiRole: rows[0].api_role,
      expiresAt: rows[0].expires_at,
    };
  }

  /**
   * Public: accept the invite — provisions the identity and marks the invite used.
   * Returns the new user's email + tenantId (for the login redirect).
   */
  async accept(
    rawToken: string,
    displayName: string | undefined,
  ): Promise<{ email: string; tenantId: string }> {
    if (!rawToken || rawToken.length < 40) throw new BadRequestException('invalid token');

    const name = (displayName ?? '').trim() || null;

    try {
      const rows = await this.prisma.$queryRaw<
        { user_id: string; tenant_id: string; api_role: string; email: string }[]
      >`SELECT user_id, tenant_id, api_role, email FROM invite_accept(${rawToken}, ${name})`;

      if (rows.length === 0) {
        throw new BadRequestException('invite accept failed — token may have expired');
      }

      return {
        email: rows[0].email,
        tenantId: rows[0].tenant_id,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Postgres RAISE EXCEPTION from invite_accept surfaces as a Prisma error.
      // Prefer the DB message when it is our known invite failure; otherwise keep
      // a safe generic (do not leak internal SQL / schema details to the client).
      const msg = err instanceof Error ? err.message : '';
      if (/invalid or expired invite token/i.test(msg)) {
        throw new BadRequestException('invalid or expired invite token');
      }
      throw new BadRequestException('invite accept failed — please try again or request a new invite');
    }
  }
}

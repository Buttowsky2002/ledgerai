import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  GroupShape,
  IdentityShape,
  PatchOp,
  applyUserPatch,
  fromScimUser,
  listResponse,
  memberIdsFromGroup,
  scimError,
  toScimGroup,
  toScimUser,
} from './scim.types';

/** SCIM request context: the tenant the bearer token resolved to + its id (audit actor). */
export interface ScimCtx {
  tenantId: string;
  tokenId: string;
}

const IDENTITY_COLS = {
  userId: true,
  email: true,
  displayName: true,
  externalId: true,
  active: true,
} as const;

/**
 * SCIM 2.0 provisioning against the control-plane store. SCIM Users map to
 * identities (source='scim'), SCIM Groups to teams; group membership sets an
 * identity's primary team_id (the single-team model — multi-group membership
 * beyond the primary team is out of scope, see ADR-034). Every operation runs
 * inside withTenant(ctx.tenantId) so Postgres RLS confines it; mutations append
 * an audit_log row with the SCIM token as the actor (rule 10).
 */
@Injectable()
export class ScimService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Users ----

  async listUsers(ctx: ScimCtx, filterEmail: string | null, startIndex: number, count: number, baseUrl: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const where = filterEmail ? { email: filterEmail } : {};
      const [rows, total] = await Promise.all([
        tx.identity.findMany({
          where,
          select: IDENTITY_COLS,
          orderBy: { userId: 'asc' },
          skip: Math.max(0, startIndex - 1),
          take: count,
        }),
        tx.identity.count({ where }),
      ]);
      return listResponse(rows.map((r) => toScimUser(r as IdentityShape, baseUrl)), total, startIndex);
    });
  }

  async getUser(ctx: ScimCtx, id: string, baseUrl: string) {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.identity.findUnique({ where: { userId: id }, select: IDENTITY_COLS }),
    );
    if (!row) {
      throw new HttpException(scimError(404, `User ${id} not found`), 404);
    }
    return toScimUser(row as IdentityShape, baseUrl);
  }

  async createUser(ctx: ScimCtx, body: Record<string, unknown>, baseUrl: string) {
    const u = fromScimUser(body);
    if (!u.email) {
      throw new HttpException(scimError(400, 'userName or an email is required', 'invalidValue'), 400);
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      try {
        const created = await tx.identity.create({
          data: {
            tenantId: ctx.tenantId,
            email: u.email!,
            displayName: u.displayName ?? null,
            externalId: u.externalId ?? null,
            source: 'scim',
            active: u.active ?? true,
          },
          select: IDENTITY_COLS,
        });
        await this.audit(tx, ctx, 'create', `identity:${created.userId}`, null, created);
        return toScimUser(created as IdentityShape, baseUrl);
      } catch (e) {
        throw this.conflictOr(e, 'User already exists');
      }
    });
  }

  async replaceUser(ctx: ScimCtx, id: string, body: Record<string, unknown>, baseUrl: string) {
    const u = fromScimUser(body);
    return this.updateUser(ctx, id, baseUrl, {
      ...(u.email ? { email: u.email } : {}),
      displayName: u.displayName ?? null,
      ...(u.externalId !== undefined ? { externalId: u.externalId } : {}),
      ...(u.active !== undefined ? { active: u.active } : {}),
    });
  }

  async patchUser(ctx: ScimCtx, id: string, ops: PatchOp[], baseUrl: string) {
    const patch = applyUserPatch(ops);
    return this.updateUser(ctx, id, baseUrl, patch);
  }

  /** SCIM DELETE soft-deactivates (active=false) to preserve FKs + audit trail. */
  async deleteUser(ctx: ScimCtx, id: string) {
    await this.updateUser(ctx, id, '', { active: false });
  }

  private async updateUser(ctx: ScimCtx, id: string, baseUrl: string, data: Record<string, unknown>) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await tx.identity.findUnique({ where: { userId: id }, select: IDENTITY_COLS });
      if (!before) {
        throw new HttpException(scimError(404, `User ${id} not found`), 404);
      }
      let after = before;
      if (Object.keys(data).length > 0) {
        try {
          after = await tx.identity.update({ where: { userId: id }, data, select: IDENTITY_COLS });
        } catch (e) {
          throw this.conflictOr(e, 'conflicting userName or externalId');
        }
        await this.audit(tx, ctx, 'update', `identity:${id}`, before, after);
      }
      return toScimUser(after as IdentityShape, baseUrl);
    });
  }

  // ---- Groups (→ teams; membership sets identity.team_id, the primary team) ----

  async listGroups(ctx: ScimCtx, startIndex: number, count: number, baseUrl: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [teams, total] = await Promise.all([
        tx.team.findMany({ orderBy: { teamId: 'asc' }, skip: Math.max(0, startIndex - 1), take: count }),
        tx.team.count(),
      ]);
      const shaped = await Promise.all(teams.map((t) => this.shapeGroup(tx, t)));
      return listResponse(shaped.map((g) => toScimGroup(g, baseUrl)), total, startIndex);
    });
  }

  async getGroup(ctx: ScimCtx, id: string, baseUrl: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const team = await tx.team.findUnique({ where: { teamId: id } });
      if (!team) {
        throw new HttpException(scimError(404, `Group ${id} not found`), 404);
      }
      return toScimGroup(await this.shapeGroup(tx, team), baseUrl);
    });
  }

  async createGroup(ctx: ScimCtx, body: Record<string, unknown>, baseUrl: string) {
    const displayName = body.displayName as string | undefined;
    if (!displayName) {
      throw new HttpException(scimError(400, 'displayName is required', 'invalidValue'), 400);
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      let team;
      try {
        team = await tx.team.create({
          data: { tenantId: ctx.tenantId, name: displayName, externalId: (body.externalId as string) ?? null },
        });
      } catch (e) {
        throw this.conflictOr(e, 'Group already exists');
      }
      await this.setMembers(tx, ctx, team.teamId, memberIdsFromGroup(body));
      await this.audit(tx, ctx, 'create', `team:${team.teamId}`, null, team);
      return toScimGroup(await this.shapeGroup(tx, team), baseUrl);
    });
  }

  async replaceGroup(ctx: ScimCtx, id: string, body: Record<string, unknown>, baseUrl: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await tx.team.findUnique({ where: { teamId: id } });
      if (!before) {
        throw new HttpException(scimError(404, `Group ${id} not found`), 404);
      }
      const data: Record<string, unknown> = {};
      if (body.displayName) {
        data.name = body.displayName;
      }
      if (body.externalId !== undefined) {
        data.externalId = body.externalId;
      }
      const after = Object.keys(data).length ? await tx.team.update({ where: { teamId: id }, data }) : before;
      // PUT replaces membership wholesale.
      await this.replaceMembers(tx, ctx, id, memberIdsFromGroup(body));
      await this.audit(tx, ctx, 'update', `team:${id}`, before, after);
      return toScimGroup(await this.shapeGroup(tx, after), baseUrl);
    });
  }

  async patchGroup(ctx: ScimCtx, id: string, ops: PatchOp[], baseUrl: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const team = await tx.team.findUnique({ where: { teamId: id } });
      if (!team) {
        throw new HttpException(scimError(404, `Group ${id} not found`), 404);
      }
      for (const op of ops) {
        const ids = Array.isArray(op.value)
          ? (op.value as { value?: string }[]).map((m) => m.value).filter((v): v is string => !!v)
          : [];
        if ((op.path ?? '').toLowerCase().startsWith('members')) {
          if (op.op === 'add') {
            await this.setMembers(tx, ctx, id, ids);
          } else if (op.op === 'remove') {
            await this.removeMembers(tx, ctx, id, ids);
          } else if (op.op === 'replace') {
            await this.replaceMembers(tx, ctx, id, ids);
          }
        } else if (op.op === 'replace' && (op.path ?? '').toLowerCase() === 'displayname') {
          await tx.team.update({ where: { teamId: id }, data: { name: String(op.value) } });
        }
      }
      const after = await tx.team.findUnique({ where: { teamId: id } });
      await this.audit(tx, ctx, 'update', `team:${id}`, team, after);
      return toScimGroup(await this.shapeGroup(tx, after!), baseUrl);
    });
  }

  /** SCIM DELETE detaches all members and removes the team. */
  async deleteGroup(ctx: ScimCtx, id: string) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const team = await tx.team.findUnique({ where: { teamId: id } });
      if (!team) {
        throw new HttpException(scimError(404, `Group ${id} not found`), 404);
      }
      await tx.identity.updateMany({ where: { teamId: id }, data: { teamId: null } });
      await tx.team.delete({ where: { teamId: id } });
      await this.audit(tx, ctx, 'delete', `team:${id}`, team, null);
    });
  }

  // ---- helpers ----

  private async shapeGroup(tx: Prisma.TransactionClient, team: { teamId: string; name: string; externalId: string | null }): Promise<GroupShape> {
    const members = await tx.identity.findMany({
      where: { teamId: team.teamId },
      select: { userId: true, email: true },
    });
    return { teamId: team.teamId, name: team.name, externalId: team.externalId, members };
  }

  private async setMembers(tx: Prisma.TransactionClient, _ctx: ScimCtx, teamId: string, userIds: string[]) {
    if (userIds.length) {
      await tx.identity.updateMany({ where: { userId: { in: userIds } }, data: { teamId } });
    }
  }

  private async removeMembers(tx: Prisma.TransactionClient, _ctx: ScimCtx, teamId: string, userIds: string[]) {
    if (userIds.length) {
      await tx.identity.updateMany({ where: { userId: { in: userIds }, teamId }, data: { teamId: null } });
    }
  }

  private async replaceMembers(tx: Prisma.TransactionClient, ctx: ScimCtx, teamId: string, userIds: string[]) {
    // Detach everyone currently on the team, then attach the new set.
    await tx.identity.updateMany({ where: { teamId }, data: { teamId: null } });
    await this.setMembers(tx, ctx, teamId, userIds);
  }

  private async audit(
    tx: Prisma.TransactionClient,
    ctx: ScimCtx,
    action: 'create' | 'update' | 'delete',
    object: string,
    before: unknown,
    after: unknown,
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actor: `scim:${ctx.tokenId}`,
        action,
        object,
        detail: JSON.parse(JSON.stringify({ before: before ?? null, after: after ?? null })),
      },
    });
  }

  private conflictOr(e: unknown, detail: string): HttpException {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new HttpException(scimError(409, detail, 'uniqueness'), 409);
    }
    return e instanceof HttpException ? e : new HttpException(scimError(400, String(e)), 400);
  }
}

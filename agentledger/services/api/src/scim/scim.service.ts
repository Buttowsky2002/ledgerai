import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  GroupShape,
  IdentityShape,
  PatchOp,
  applyUserPatch,
  departmentFromAliases,
  fromScimUser,
  listResponse,
  memberIdsFromGroup,
  memberIdsFromPatchOp,
  mergeDepartmentAlias,
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
 * identities (source='scim'), SCIM Groups to teams. FinOps primary team comes
 * from User enterprise department (always wins). Group membership only fills
 * team_id when still null so Entra assignment groups do not overwrite org
 * departments (ADR-034 single-team model). Every operation runs
 * inside withTenant(ctx.tenantId) so Postgres RLS confines it; mutations append
 * an audit_log row with the SCIM token as the actor (rule 10).
 */
@Injectable()
export class ScimService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Users ----

  async listUsers(
    ctx: ScimCtx,
    filterEmail: string | null,
    startIndex: number,
    count: number,
    baseUrl: string,
  ) {
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
      return listResponse(
        rows.map((r) => toScimUser(r as IdentityShape, baseUrl)),
        total,
        startIndex,
      );
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
      throw new HttpException(
        scimError(400, 'userName or an email is required', 'invalidValue'),
        400,
      );
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
        if (u.department) {
          await this.assignTeamByName(tx, ctx, created.userId, u.department);
        }
        await this.audit(tx, ctx, 'create', `identity:${created.userId}`, null, created);
        return toScimUser(created as IdentityShape, baseUrl);
      } catch (e) {
        throw this.conflictOr(e, 'User already exists');
      }
    });
  }

  async replaceUser(ctx: ScimCtx, id: string, body: Record<string, unknown>, baseUrl: string) {
    const u = fromScimUser(body);
    return this.updateUser(
      ctx,
      id,
      baseUrl,
      {
        ...(u.email ? { email: u.email } : {}),
        displayName: u.displayName ?? null,
        ...(u.externalId !== undefined ? { externalId: u.externalId } : {}),
        ...(u.active !== undefined ? { active: u.active } : {}),
      },
      u.department,
    );
  }

  async patchUser(ctx: ScimCtx, id: string, ops: PatchOp[], baseUrl: string) {
    const patch = applyUserPatch(ops);
    const { department, ...identityPatch } = patch;
    return this.updateUser(ctx, id, baseUrl, identityPatch, department);
  }

  /** SCIM DELETE soft-deactivates (active=false) to preserve FKs + audit trail. */
  async deleteUser(ctx: ScimCtx, id: string) {
    await this.updateUser(ctx, id, '', { active: false });
  }

  private async updateUser(
    ctx: ScimCtx,
    id: string,
    baseUrl: string,
    data: Record<string, unknown>,
    department?: string,
  ) {
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
      }
      if (department) {
        await this.assignTeamByName(tx, ctx, id, department);
      }
      if (Object.keys(data).length > 0 || department) {
        await this.audit(tx, ctx, 'update', `identity:${id}`, before, after);
      }
      return toScimUser(after as IdentityShape, baseUrl);
    });
  }

  // ---- Groups (→ teams; membership sets identity.team_id, the primary team) ----

  async listGroups(
    ctx: ScimCtx,
    filterName: string | null,
    startIndex: number,
    count: number,
    baseUrl: string,
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Entra matches groups by displayName eq "…" before create/update.
      const where = filterName ? { name: filterName } : {};
      const [teams, total] = await Promise.all([
        tx.team.findMany({
          where,
          orderBy: { teamId: 'asc' },
          skip: Math.max(0, startIndex - 1),
          take: count,
        }),
        tx.team.count({ where }),
      ]);
      const shaped = await Promise.all(teams.map((t) => this.shapeGroup(tx, t)));
      return listResponse(
        shaped.map((g) => toScimGroup(g, baseUrl)),
        total,
        startIndex,
      );
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
          data: {
            tenantId: ctx.tenantId,
            name: displayName,
            externalId: (body.externalId as string) ?? null,
          },
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
      const after = Object.keys(data).length
        ? await tx.team.update({ where: { teamId: id }, data })
        : before;
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
        const path = (op.path ?? '').toLowerCase();
        const memberRefs = memberIdsFromPatchOp(op);
        if (path.startsWith('members') || (memberRefs.length > 0 && !path)) {
          if (op.op === 'add') {
            await this.setMembers(tx, ctx, id, memberRefs);
          } else if (op.op === 'remove') {
            await this.removeMembers(tx, ctx, id, memberRefs);
          } else if (op.op === 'replace') {
            await this.replaceMembers(tx, ctx, id, memberRefs);
          }
        } else if (op.op === 'replace' && path === 'displayname') {
          await tx.team.update({ where: { teamId: id }, data: { name: String(op.value) } });
        } else if (op.op === 'replace' && !op.path && op.value && typeof op.value === 'object') {
          const v = op.value as Record<string, unknown>;
          if (typeof v.displayName === 'string') {
            await tx.team.update({ where: { teamId: id }, data: { name: v.displayName } });
          }
          if (Array.isArray(v.members)) {
            await this.replaceMembers(tx, ctx, id, memberIdsFromGroup({ members: v.members }));
          }
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

  private async shapeGroup(
    tx: Prisma.TransactionClient,
    team: { teamId: string; name: string; externalId: string | null },
  ): Promise<GroupShape> {
    const members = await tx.identity.findMany({
      where: { teamId: team.teamId },
      select: { userId: true, email: true },
    });
    return { teamId: team.teamId, name: team.name, externalId: team.externalId, members };
  }

  /** Find-or-create a team by display name and set the identity's primary team_id. */
  private async assignTeamByName(
    tx: Prisma.TransactionClient,
    ctx: ScimCtx,
    userId: string,
    department: string,
  ) {
    const name = department.trim();
    if (!name) {
      return;
    }
    let team = await tx.team.findFirst({ where: { name } });
    if (!team) {
      try {
        team = await tx.team.create({
          data: { tenantId: ctx.tenantId, name },
        });
      } catch (e) {
        // Concurrent create on unique (tenant_id, name) — re-read.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          team = await tx.team.findFirst({ where: { name } });
        } else {
          throw e;
        }
      }
    }
    if (!team) {
      return;
    }
    const row = await tx.identity.findUnique({
      where: { userId },
      select: { aliases: true },
    });
    const aliases = mergeDepartmentAlias(row?.aliases, name) as Prisma.InputJsonValue;
    await tx.identity.update({
      where: { userId },
      data: { teamId: team.teamId, aliases },
    });
  }

  /**
   * Resolve SCIM member refs to identity userIds. Entra usually sends our SCIM
   * User id; some flows send externalId (mailNickname / object id) instead.
   */
  private async resolveMemberUserIds(
    tx: Prisma.TransactionClient,
    refs: string[],
  ): Promise<string[]> {
    if (!refs.length) {
      return [];
    }
    const byId = await tx.identity.findMany({
      where: { userId: { in: refs } },
      select: { userId: true },
    });
    const resolved = new Set(byId.map((r) => r.userId));
    const missing = refs.filter((r) => !resolved.has(r));
    if (missing.length) {
      const byExt = await tx.identity.findMany({
        where: { externalId: { in: missing } },
        select: { userId: true },
      });
      for (const r of byExt) {
        resolved.add(r.userId);
      }
    }
    return [...resolved];
  }

  /**
   * Group membership fills team_id only when unset. User.department always wins
   * for FinOps (assignTeamByName overwrites) so Entra assignment groups like
   * "BadgerIQ - AI users- SCIM" do not replace org department teams.
   */
  private async setMembers(
    tx: Prisma.TransactionClient,
    ctx: ScimCtx,
    teamId: string,
    memberRefs: string[],
  ) {
    const userIds = await this.resolveMemberUserIds(tx, memberRefs);
    if (!userIds.length) {
      return;
    }
    await tx.identity.updateMany({
      where: { userId: { in: userIds }, teamId: null },
      data: { teamId },
    });
    // Re-assert stored department so Group sync cannot leave users on the
    // assignment-group team after a prior department map.
    const rows = await tx.identity.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, aliases: true },
    });
    for (const row of rows) {
      const dept = departmentFromAliases(row.aliases);
      if (dept) {
        await this.assignTeamByName(tx, ctx, row.userId, dept);
      }
    }
  }

  private async removeMembers(
    tx: Prisma.TransactionClient,
    _ctx: ScimCtx,
    teamId: string,
    memberRefs: string[],
  ) {
    const userIds = await this.resolveMemberUserIds(tx, memberRefs);
    if (userIds.length) {
      await tx.identity.updateMany({
        where: { userId: { in: userIds }, teamId },
        data: { teamId: null },
      });
    }
  }

  private async replaceMembers(
    tx: Prisma.TransactionClient,
    ctx: ScimCtx,
    teamId: string,
    memberRefs: string[],
  ) {
    // Diff-based replace: do not blast-clear other members' department teams.
    const nextIds = await this.resolveMemberUserIds(tx, memberRefs);
    const next = new Set(nextIds);
    const current = await tx.identity.findMany({
      where: { teamId },
      select: { userId: true },
    });
    const toRemove = current.map((r) => r.userId).filter((id) => !next.has(id));
    if (toRemove.length) {
      await tx.identity.updateMany({
        where: { userId: { in: toRemove }, teamId },
        data: { teamId: null },
      });
    }
    await this.setMembers(tx, ctx, teamId, memberRefs);
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

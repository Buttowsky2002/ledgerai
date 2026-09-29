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
  hasScimGroupAlias,
  listResponse,
  memberIdsFromGroup,
  memberIdsFromPatchOp,
  mergeDepartmentAlias,
  mergeScimGroupAlias,
  removeScimGroupAlias,
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
  aliases: true,
  teamId: true,
} as const;

/**
 * SCIM 2.0 provisioning against the control-plane store. SCIM Users map to
 * identities (source='scim'). FinOps primary team (`identity.team_id`) comes
 * from the User enterprise `department` attribute (Entra [department] mapping).
 * SCIM Groups are assignment/membership only (`scim-group:<teamId>` aliases) —
 * Group displayName must not become the FinOps department (assignment groups
 * like "AI Provisioning" are not departments). Every operation runs inside
 * withTenant(ctx.tenantId) so Postgres RLS confines it; mutations append an
 * audit_log row with the SCIM token as the actor (rule 10).
 */
@Injectable()
export class ScimService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Users ----

  async listUsers(
    ctx: ScimCtx,
    filterUserName: string | null,
    startIndex: number,
    count: number,
    baseUrl: string,
  ) {
    // Unstick assignment-Group team_ids + re-apply User.department (Entra
    // provision-on-demand often hits Users before Groups).
    try {
      await this.backfillTeamsFromScimGroups(ctx);
    } catch {
      /* ignore — write path still assigns department */
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Entra commonly filters userName eq "<objectId>" or email. Match email
      // or external_id so re-provision / updates find the same identity.
      const where = filterUserName
        ? {
            OR: [
              { email: { equals: filterUserName, mode: 'insensitive' as const } },
              { externalId: { equals: filterUserName, mode: 'insensitive' as const } },
            ],
          }
        : {};
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
      const teamNames = await this.teamNameMap(
        tx,
        rows.map((r) => r.teamId),
      );
      return listResponse(
        rows.map((r) => toScimUser(this.toIdentityShape(r, teamNames), baseUrl)),
        total,
        startIndex,
      );
    });
  }

  async getUser(ctx: ScimCtx, id: string, baseUrl: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.identity.findUnique({
        where: { userId: id },
        select: IDENTITY_COLS,
      });
      if (!row) {
        throw new HttpException(scimError(404, `User ${id} not found`), 404);
      }
      const teamNames = await this.teamNameMap(tx, [row.teamId]);
      return toScimUser(this.toIdentityShape(row, teamNames), baseUrl);
    });
  }

  async createUser(ctx: ScimCtx, body: Record<string, unknown>, baseUrl: string) {
    const u = fromScimUser(body);
    if (!u.email) {
      throw new HttpException(
        scimError(
          400,
          'A work email is required (map Entra mail → emails[type eq "work"].value)',
          'invalidValue',
        ),
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
        const fresh = await tx.identity.findUnique({
          where: { userId: created.userId },
          select: IDENTITY_COLS,
        });
        const shaped = fresh ?? created;
        const teamNames = await this.teamNameMap(tx, [shaped.teamId]);
        return toScimUser(this.toIdentityShape(shaped, teamNames), baseUrl);
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
      const fresh = await tx.identity.findUnique({
        where: { userId: id },
        select: IDENTITY_COLS,
      });
      const shaped = fresh ?? after;
      const teamNames = await this.teamNameMap(tx, [shaped.teamId]);
      return toScimUser(this.toIdentityShape(shaped, teamNames), baseUrl);
    });
  }

  // ---- Groups (→ teams; membership via aliases, not identity.team_id) ----

  async listGroups(
    ctx: ScimCtx,
    filterName: string | null,
    startIndex: number,
    count: number,
    baseUrl: string,
  ) {
    // Heal members who got Group aliases under the old department-only policy.
    // Never fail Entra Group discovery if backfill hits a transient DB error.
    try {
      await this.backfillTeamsFromScimGroups(ctx);
    } catch {
      /* ignore — setMembers still assigns team_id on the write path */
    }
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

  /** SCIM DELETE clears group membership aliases and removes the team. */
  async deleteGroup(ctx: ScimCtx, id: string) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const team = await tx.team.findUnique({ where: { teamId: id } });
      if (!team) {
        throw new HttpException(scimError(404, `Group ${id} not found`), 404);
      }
      // Unstick anyone whose FinOps team was this Group, then drop membership aliases.
      const stuck = await tx.identity.findMany({
        where: { teamId: id },
        select: { userId: true, aliases: true },
      });
      for (const row of stuck) {
        const dept = departmentFromAliases(row.aliases);
        await tx.identity.update({
          where: { userId: row.userId },
          data: {
            teamId: null,
            aliases: removeScimGroupAlias(row.aliases, id) as Prisma.InputJsonValue,
          },
        });
        if (dept) {
          await this.assignTeamByName(tx, ctx, row.userId, dept);
        }
      }
      const marked = await this.identitiesInScimGroup(tx, id);
      for (const row of marked) {
        if (stuck.some((s) => s.userId === row.userId)) {
          continue;
        }
        await tx.identity.update({
          where: { userId: row.userId },
          data: {
            aliases: removeScimGroupAlias(row.aliases, id) as Prisma.InputJsonValue,
          },
        });
      }
      await tx.team.delete({ where: { teamId: id } });
      await this.audit(tx, ctx, 'delete', `team:${id}`, team, null);
    });
  }

  // ---- helpers ----

  private async shapeGroup(
    tx: Prisma.TransactionClient,
    team: { teamId: string; name: string; externalId: string | null },
  ): Promise<GroupShape> {
    const members = await this.identitiesInScimGroup(tx, team.teamId);
    return {
      teamId: team.teamId,
      name: team.name,
      externalId: team.externalId,
      members: members.map((m) => ({ userId: m.userId, email: m.email })),
    };
  }

  /** Identities with a `scim-group:<teamId>` alias (Entra Group membership). */
  private async identitiesInScimGroup(
    tx: Prisma.TransactionClient,
    teamId: string,
  ): Promise<{ userId: string; email: string; aliases: unknown; teamId: string | null }[]> {
    // Tenant-scoped via withTenant RLS; filter membership aliases in-process
    // (Json containment varies across Prisma/PG drivers).
    const rows = await tx.identity.findMany({
      select: { userId: true, email: true, aliases: true, teamId: true },
    });
    return rows
      .filter((r) => hasScimGroupAlias(r.aliases, teamId))
      .map((r) => ({
        userId: r.userId,
        email: r.email,
        aliases: r.aliases,
        teamId: r.teamId,
      }));
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
   * Record Group membership only. FinOps team_id comes from User.department —
   * never from the assignment Group's displayName (that used to overwrite
   * Engineering/Security/etc. with names like "AI Provisioning").
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
    const team = await tx.team.findUnique({
      where: { teamId },
      select: { teamId: true, name: true },
    });
    if (!team) {
      return;
    }
    const rows = await tx.identity.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, aliases: true, teamId: true },
    });
    for (const row of rows) {
      const aliases = mergeScimGroupAlias(row.aliases, teamId);
      const enterpriseDept = departmentFromAliases(aliases);
      // Clear team_id when it was incorrectly set to this assignment Group.
      const stuckOnAssignmentGroup = row.teamId === teamId && !enterpriseDept;
      await tx.identity.update({
        where: { userId: row.userId },
        data: {
          aliases: aliases as Prisma.InputJsonValue,
          ...(stuckOnAssignmentGroup ? { teamId: null } : {}),
        },
      });
      if (enterpriseDept) {
        await this.assignTeamByName(tx, ctx, row.userId, enterpriseDept);
      }
    }
  }

  private async removeMembers(
    tx: Prisma.TransactionClient,
    ctx: ScimCtx,
    teamId: string,
    memberRefs: string[],
  ) {
    const userIds = await this.resolveMemberUserIds(tx, memberRefs);
    if (!userIds.length) {
      return;
    }
    const rows = await tx.identity.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, aliases: true, teamId: true },
    });
    for (const row of rows) {
      if (!hasScimGroupAlias(row.aliases, teamId) && row.teamId !== teamId) {
        continue;
      }
      const aliases = removeScimGroupAlias(row.aliases, teamId);
      const wasPrimaryTeam = row.teamId === teamId;
      await tx.identity.update({
        where: { userId: row.userId },
        data: {
          aliases: aliases as Prisma.InputJsonValue,
          ...(wasPrimaryTeam ? { teamId: null } : {}),
        },
      });
      if (wasPrimaryTeam) {
        const dept = departmentFromAliases(aliases);
        if (dept) {
          await this.assignTeamByName(tx, ctx, row.userId, dept);
        }
      }
    }
  }

  private async replaceMembers(
    tx: Prisma.TransactionClient,
    ctx: ScimCtx,
    teamId: string,
    memberRefs: string[],
  ) {
    const nextIds = await this.resolveMemberUserIds(tx, memberRefs);
    const next = new Set(nextIds);
    const current = await this.identitiesInScimGroup(tx, teamId);
    const legacy = await tx.identity.findMany({
      where: { teamId },
      select: { userId: true },
    });
    const currentIds = new Set([...current.map((r) => r.userId), ...legacy.map((r) => r.userId)]);
    const toRemove = [...currentIds].filter((id) => !next.has(id));
    if (toRemove.length) {
      await this.removeMembers(tx, ctx, teamId, toRemove);
    }
    await this.setMembers(tx, ctx, teamId, memberRefs);
  }

  /**
   * Heal identities that have a stored enterprise department alias but no
   * team_id, and unstick anyone whose team_id still points at an assignment
   * Group (legacy Group-name → team policy). Safe / idempotent.
   */
  async backfillTeamsFromScimGroups(ctx: ScimCtx): Promise<number> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.identity.findMany({
        where: { active: true },
        select: { userId: true, aliases: true, teamId: true },
      });
      let fixed = 0;
      for (const row of rows) {
        const dept = departmentFromAliases(row.aliases);
        if (dept) {
          await this.assignTeamByName(tx, ctx, row.userId, dept);
          fixed += 1;
          continue;
        }
        // No User.department — if team_id is a SCIM assignment Group, clear it.
        if (row.teamId && hasScimGroupAlias(row.aliases, row.teamId)) {
          await tx.identity.update({
            where: { userId: row.userId },
            data: { teamId: null },
          });
          fixed += 1;
        }
      }
      return fixed;
    });
  }

  private async teamNameMap(
    tx: Prisma.TransactionClient,
    teamIds: (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(teamIds.filter((id): id is string => Boolean(id)))];
    if (!ids.length) {
      return new Map();
    }
    const teams = await tx.team.findMany({
      where: { teamId: { in: ids } },
      select: { teamId: true, name: true },
    });
    return new Map(teams.map((t) => [t.teamId, t.name]));
  }

  private toIdentityShape(
    row: {
      userId: string;
      email: string;
      displayName: string | null;
      externalId: string | null;
      active: boolean;
      aliases?: unknown;
      teamId?: string | null;
    },
    teamNames: Map<string, string> = new Map(),
  ): IdentityShape {
    return {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      externalId: row.externalId,
      active: row.active,
      aliases: row.aliases,
      teamName: row.teamId ? (teamNames.get(row.teamId) ?? null) : null,
    };
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

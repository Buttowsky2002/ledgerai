import type { PrismaService } from '../prisma/prisma.service';
import type { UserSpendRow } from './executive-report.types';

export const UNASSIGNED_LABEL = 'Unassigned';
export const UNATTRIBUTED_LABEL = 'Unattributed';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailLike(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

type IdentityEntry = { displayName: string; email: string | null; teamName: string };

export type UserDirectoryIdentity = {
  display_name: string;
  email: string | null;
  team: string;
  resolved: boolean;
};

type VIdentityRow = {
  identity_id: string;
  display_name: string | null;
  email: string | null;
  team_id: string | null;
};

export interface ResolvedUserSpend extends UserSpendRow {
  resolved: boolean;
}

/** COALESCE(display_name, email local-part, handle) — never "Unknown user". */
export function resolveDisplayName(
  displayName: string | null | undefined,
  email: string | null | undefined,
  handle?: string,
): string {
  const dn = displayName?.trim();
  if (dn) return dn;
  const em = email?.trim();
  if (em) {
    const at = em.indexOf('@');
    return at > 0 ? em.slice(0, at) : em;
  }
  const h = handle?.trim();
  if (h) return h;
  return UNASSIGNED_LABEL;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      for (const key of ['id', 'email', 'value', 'alias']) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim()) out.push(v.trim());
      }
    }
  }
  return out;
}

/**
 * Resolve a raw spend user_id against identity graph:
 * 1. exact identities.user_id (UUID)
 * 2. case-insensitive identities.email
 * 3. membership in identities.aliases (JSONB)
 */
export function matchIdentity(
  userId: string,
  byId: Map<string, IdentityEntry>,
  byEmail: Map<string, IdentityEntry>,
  byAlias: Map<string, IdentityEntry>,
): IdentityEntry | null {
  if (UUID_RE.test(userId) && byId.has(userId)) return byId.get(userId)!;
  const emailHit = byEmail.get(normalizeKey(userId));
  if (emailHit) return emailHit;
  const aliasHit = byAlias.get(normalizeKey(userId));
  if (aliasHit) return aliasHit;
  return null;
}

/** Resolve one spend user_id for the member directory — keeps unresolved handles as-is. */
export function resolveUserDirectoryIdentity(
  userId: string,
  byId: Map<string, IdentityEntry>,
  byEmail: Map<string, IdentityEntry>,
  byAlias: Map<string, IdentityEntry>,
): UserDirectoryIdentity {
  const hit = matchIdentity(userId, byId, byEmail, byAlias);
  if (hit) {
    return {
      display_name: hit.displayName,
      email: hit.email,
      team: hit.teamName,
      resolved: true,
    };
  }
  const trimmed = userId.trim();
  if (isEmailLike(trimmed)) {
    return {
      display_name: resolveDisplayName(null, trimmed, trimmed),
      email: trimmed,
      team: '',
      resolved: false,
    };
  }
  return {
    display_name: userId,
    email: null,
    team: '',
    resolved: false,
  };
}

/** Top N resolved users plus optional Unattributed / Unassigned bars for charts. */
export function rollupUserSpendForChart(rows: UserSpendRow[], topN = 15): UserSpendRow[] {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const special = rows.filter(
    (r) =>
      r.userId === '__unattributed__' ||
      r.userId === '__unassigned__' ||
      r.displayName === UNASSIGNED_LABEL ||
      r.displayName.startsWith(UNATTRIBUTED_LABEL),
  );
  const ranked = rows
    .filter((r) => !special.includes(r))
    .filter((r) => r.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);

  if (ranked.length === 0 && special.length === 0) return [];

  const out: UserSpendRow[] = [];
  if (ranked.length <= topN) {
    out.push(...ranked);
  } else {
    out.push(...ranked.slice(0, topN));
    const rest = ranked.slice(topN);
    out.push({
      userId: '__others__',
      displayName: 'All others',
      teamName: '',
      costUsd: round2(rest.reduce((s, r) => s + r.costUsd, 0)),
      calls: rest.reduce((s, r) => s + r.calls, 0),
    });
  }
  for (const row of special) {
    if (row.costUsd > 0) out.push(row);
  }
  return out;
}

/** Resolve spend rows via v_identities + aliases; bucket unresolved into one row. */
export async function resolveUserIdentities(
  prisma: PrismaService,
  tenantId: string,
  rows: Omit<UserSpendRow, 'displayName' | 'teamName'>[],
): Promise<UserSpendRow[]> {
  if (rows.length === 0) return [];

  const { byId, byEmail, byAlias } = await loadIdentityLookups(prisma, tenantId);

  const resolved: UserSpendRow[] = [];
  let unattributedCost = 0;
  let unattributedCalls = 0;
  let unattributedIds = 0;
  let unassignedCost = 0;
  let unassignedCalls = 0;

  for (const row of rows) {
    if (row.userId === 'Unassigned' || row.userId === '') {
      unassignedCost += row.costUsd;
      unassignedCalls += row.calls;
      continue;
    }
    const hit = matchIdentity(row.userId, byId, byEmail, byAlias);
    if (hit) {
      resolved.push({ ...row, displayName: hit.displayName, teamName: hit.teamName });
    } else {
      unattributedCost += row.costUsd;
      unattributedCalls += row.calls;
      unattributedIds += 1;
    }
  }

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const merged = [...resolved];
  if (unattributedIds > 0 && unattributedCost > 0) {
    const suffix = unattributedIds === 1 ? '' : ` (${unattributedIds} identifiers)`;
    merged.push({
      userId: '__unattributed__',
      displayName: `${UNATTRIBUTED_LABEL}${suffix}`,
      teamName: '',
      costUsd: round2(unattributedCost),
      calls: unattributedCalls,
    });
  }
  if (unassignedCost > 0) {
    merged.push({
      userId: '__unassigned__',
      displayName: UNASSIGNED_LABEL,
      teamName: '',
      costUsd: round2(unassignedCost),
      calls: unassignedCalls,
    });
  }
  return merged;
}

export async function loadIdentityLookups(
  prisma: PrismaService,
  tenantId: string,
): Promise<{
  byId: Map<string, IdentityEntry>;
  byEmail: Map<string, IdentityEntry>;
  byAlias: Map<string, IdentityEntry>;
}> {
  return prisma.withTenant(tenantId, async (tx) => {
    const vRows = await tx.$queryRaw<VIdentityRow[]>`
      SELECT identity_id::text, display_name, email, team_id::text
      FROM v_identities
      WHERE tenant_id = ${tenantId}::uuid AND identity_type = 'human'
    `;
    const identityRows = await tx.identity.findMany({
      select: { userId: true, email: true, displayName: true, teamId: true, aliases: true },
    });
    const teamIds = [
      ...new Set([
        ...vRows.map((r) => r.team_id).filter(Boolean),
        ...identityRows.map((r) => r.teamId).filter(Boolean),
      ]),
    ] as string[];
    const teams =
      teamIds.length > 0
        ? await tx.team.findMany({ where: { teamId: { in: teamIds } }, select: { teamId: true, name: true } })
        : [];
    const teamNames = new Map(teams.map((t) => [t.teamId, t.name]));

    const byId = new Map<string, IdentityEntry>();
    const byEmail = new Map<string, IdentityEntry>();
    const byAlias = new Map<string, IdentityEntry>();

    const register = (
      id: string,
      displayName: string | null,
      email: string | null,
      teamId: string | null,
      aliases: string[] = [],
    ) => {
      const entry: IdentityEntry = {
        displayName: resolveDisplayName(displayName, email, id),
        email: email?.trim() || null,
        teamName: teamId ? (teamNames.get(teamId) ?? '') : '',
      };
      if (UUID_RE.test(id)) byId.set(id, entry);
      if (email?.trim()) byEmail.set(normalizeKey(email), entry);
      for (const alias of aliases) {
        byAlias.set(normalizeKey(alias), entry);
        if (isEmailLike(alias)) byEmail.set(normalizeKey(alias), entry);
      }
    };

    for (const row of vRows) {
      register(row.identity_id, row.display_name, row.email, row.team_id);
    }

    for (const row of identityRows) {
      const aliases = parseAliases(row.aliases);
      register(row.userId, row.displayName, row.email, row.teamId, aliases);
    }

    return { byId, byEmail, byAlias };
  });
}

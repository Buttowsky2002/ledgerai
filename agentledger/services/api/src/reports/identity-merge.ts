/**
 * Collapse duplicate human identities (same display name, different emails) onto
 * one primary person, and link Copilot/GitHub handles as aliases so the Users
 * directory shows a single row.
 */

import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Corporate domains preferred as the primary email when collapsing duplicates. */
const PREFERRED_EMAIL_SUFFIXES = ['@studiodesigner.com'];

export type MergeableIdentity = {
  userId: string;
  email: string;
  displayName: string | null;
  aliases: string[];
  teamId: string | null;
  active: boolean;
};

export function normalizeDisplayNameKey(name: string | null | undefined): string {
  if (!name?.trim()) {
    return '';
  }
  return name.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

export function parseAliasList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      for (const key of ['id', 'email', 'value', 'alias']) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim()) {
          out.push(v.trim());
        }
      }
    }
  }
  return out;
}

export function mergeAliasLists(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const v = raw.trim();
      if (!v) {
        continue;
      }
      const key = v.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

function emailRank(email: string): number {
  const e = email.trim().toLowerCase();
  for (let i = 0; i < PREFERRED_EMAIL_SUFFIXES.length; i++) {
    if (e.endsWith(PREFERRED_EMAIL_SUFFIXES[i]!)) {
      return i;
    }
  }
  return PREFERRED_EMAIL_SUFFIXES.length;
}

/** Pick the identity that should own the merged person record. */
export function pickPrimaryIdentity(group: MergeableIdentity[]): MergeableIdentity {
  if (group.length === 0) {
    throw new Error('pickPrimaryIdentity: empty group');
  }
  return [...group].sort((a, b) => {
    const rankDiff = emailRank(a.email) - emailRank(b.email);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const aliasDiff = b.aliases.length - a.aliases.length;
    if (aliasDiff !== 0) {
      return aliasDiff;
    }
    const teamDiff = Number(Boolean(b.teamId)) - Number(Boolean(a.teamId));
    if (teamDiff !== 0) {
      return teamDiff;
    }
    return a.email.localeCompare(b.email);
  })[0]!;
}

/** Groups of 2+ active identities that share a normalized display name. */
export function groupIdentitiesByDisplayName(
  rows: MergeableIdentity[],
): Map<string, MergeableIdentity[]> {
  const groups = new Map<string, MergeableIdentity[]>();
  for (const row of rows) {
    if (!row.active) {
      continue;
    }
    const key = normalizeDisplayNameKey(row.displayName);
    if (!key) {
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [key, list] of [...groups.entries()]) {
    if (list.length < 2) {
      groups.delete(key);
    }
  }
  return groups;
}

/**
 * Map every identity userId in a merge group → primary userId.
 * Singletons map to themselves.
 */
export function primaryUserIdByIdentityId(rows: MergeableIdentity[]): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, MergeableIdentity[]>();
  for (const row of rows) {
    if (!row.active) {
      out.set(row.userId, row.userId);
      continue;
    }
    const key = normalizeDisplayNameKey(row.displayName);
    if (!key) {
      out.set(row.userId, row.userId);
      continue;
    }
    const list = byName.get(key) ?? [];
    list.push(row);
    byName.set(key, list);
  }
  for (const list of byName.values()) {
    const primary = list.length >= 2 ? pickPrimaryIdentity(list) : list[0]!;
    for (const row of list) {
      out.set(row.userId, primary.userId);
    }
  }
  return out;
}

/** Primary userIds that should appear on the roster (duplicates collapsed). */
export function rosterPrimaryUserIds(rows: MergeableIdentity[]): Set<string> {
  const map = primaryUserIdByIdentityId(rows);
  return new Set(map.values());
}

export type CopilotMemberLink = {
  githubLogin: string;
  email?: string | null;
  displayName?: string | null;
};

/**
 * Decide which identity should receive a Copilot githubLogin alias.
 * Prefers email match, then unique display-name match among active identities.
 */
export function resolveIdentityForCopilotMember(
  member: CopilotMemberLink,
  identities: MergeableIdentity[],
): MergeableIdentity | null {
  const active = identities.filter((i) => i.active);
  const email = member.email?.trim().toLowerCase();
  if (email && EMAIL_RE.test(email)) {
    const byEmail = active.find((i) => i.email.toLowerCase() === email);
    if (byEmail) {
      return byEmail;
    }
    const byAlias = active.find((i) => i.aliases.some((a) => a.trim().toLowerCase() === email));
    if (byAlias) {
      return byAlias;
    }
  }

  const nameKey = normalizeDisplayNameKey(member.displayName);
  if (!nameKey) {
    return null;
  }
  const nameMatches = active.filter((i) => normalizeDisplayNameKey(i.displayName) === nameKey);
  if (nameMatches.length === 0) {
    return null;
  }
  // Unique name, or collapse to preferred primary when duplicates exist.
  return pickPrimaryIdentity(nameMatches);
}

/**
 * Persist display-name duplicates onto one primary (aliases + deactivate extras).
 * Idempotent — returns how many secondary identities were deactivated / linked.
 */
export async function reconcileDuplicateIdentities(
  prisma: PrismaService,
  tenantId: string,
): Promise<number> {
  return prisma.withTenant(tenantId, async (tx) => {
    const rows = await tx.identity.findMany({
      where: { active: true },
      select: {
        userId: true,
        email: true,
        displayName: true,
        aliases: true,
        teamId: true,
        active: true,
      },
    });
    const mergeable: MergeableIdentity[] = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      displayName: r.displayName,
      aliases: parseAliasList(r.aliases),
      teamId: r.teamId,
      active: r.active,
    }));
    const groups = groupIdentitiesByDisplayName(mergeable);
    let linked = 0;
    for (const group of groups.values()) {
      const primary = pickPrimaryIdentity(group);
      const secondary = group.filter((g) => g.userId !== primary.userId);
      if (secondary.length === 0) {
        continue;
      }
      const nextAliases = mergeAliasLists(
        primary.aliases,
        ...secondary.map((s) => [s.email, ...s.aliases]),
      );
      const aliasesChanged =
        nextAliases.length !== primary.aliases.length ||
        nextAliases.some((a, i) => a.toLowerCase() !== (primary.aliases[i] ?? '').toLowerCase());
      if (aliasesChanged) {
        await tx.identity.update({
          where: { userId: primary.userId },
          data: { aliases: nextAliases as Prisma.InputJsonValue },
        });
      }
      for (const sec of secondary) {
        await tx.identity.update({
          where: { userId: sec.userId },
          data: { active: false },
        });
        linked += 1;
      }
    }
    return linked;
  });
}

/**
 * Attach Copilot githubLogins (and emails) onto matching identities as aliases.
 */
export async function linkCopilotMembersToIdentities(
  prisma: PrismaService,
  tenantId: string,
  members: CopilotMemberLink[],
): Promise<number> {
  if (members.length === 0) {
    return 0;
  }
  return prisma.withTenant(tenantId, async (tx) => {
    const rows = await tx.identity.findMany({
      where: { active: true },
      select: {
        userId: true,
        email: true,
        displayName: true,
        aliases: true,
        teamId: true,
        active: true,
      },
    });
    const mergeable: MergeableIdentity[] = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      displayName: r.displayName,
      aliases: parseAliasList(r.aliases),
      teamId: r.teamId,
      active: r.active,
    }));
    // Work on a mutable copy so multiple members can attach to the same person.
    const byId = new Map(mergeable.map((m) => [m.userId, { ...m, aliases: [...m.aliases] }]));
    let linked = 0;
    for (const member of members) {
      const login = member.githubLogin?.trim();
      if (!login) {
        continue;
      }
      const target = resolveIdentityForCopilotMember(member, [...byId.values()]);
      if (!target) {
        continue;
      }
      const cur = byId.get(target.userId);
      if (!cur) {
        continue;
      }
      const extras = [login];
      if (member.email?.trim() && member.email.trim().toLowerCase() !== cur.email.toLowerCase()) {
        extras.push(member.email.trim());
      }
      const next = mergeAliasLists(cur.aliases, extras);
      if (next.length === cur.aliases.length) {
        continue;
      }
      cur.aliases = next;
      byId.set(cur.userId, cur);
      await tx.identity.update({
        where: { userId: cur.userId },
        data: { aliases: next as Prisma.InputJsonValue },
      });
      linked += 1;
    }
    return linked;
  });
}

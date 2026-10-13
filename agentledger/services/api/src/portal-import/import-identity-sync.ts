/**
 * Resolve portal-import emails/aliases onto the canonical Users-directory
 * identity so seat tiers land on the person the operator opens — not a
 * case-mismatched portal_import duplicate.
 */

const PREFERRED_EMAIL_SUFFIXES = ['@studiodesigner.com'];

export type SyncIdentityRow = {
  userId: string;
  email: string;
  aliases: string[];
  active: boolean;
  source: string;
};

export type ImportIdentityCandidate = {
  /** Lowercased email from the CSV. */
  email: string;
  displayName?: string;
  aliases: string[];
};

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function emailRank(email: string): number {
  const e = norm(email);
  for (let i = 0; i < PREFERRED_EMAIL_SUFFIXES.length; i++) {
    if (e.endsWith(PREFERRED_EMAIL_SUFFIXES[i]!)) {
      return i;
    }
  }
  return PREFERRED_EMAIL_SUFFIXES.length;
}

function identityKeys(row: SyncIdentityRow): Set<string> {
  const keys = new Set<string>();
  keys.add(norm(row.email));
  for (const a of row.aliases) {
    keys.add(norm(a));
  }
  return keys;
}

function candidateKeys(candidate: ImportIdentityCandidate): Set<string> {
  const keys = new Set<string>([norm(candidate.email)]);
  for (const a of candidate.aliases) {
    keys.add(norm(a));
  }
  return keys;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const k of a) {
    if (b.has(k)) {
      return true;
    }
  }
  return false;
}

/**
 * Pick the directory identity that should receive seat licenses for this
 * import email. Prefers active, non-portal_import shells and preferred domains.
 * Returns null when no existing identity matches (caller may create one).
 */
export function resolveCanonicalIdentity(
  candidate: ImportIdentityCandidate,
  identities: SyncIdentityRow[],
): SyncIdentityRow | null {
  const want = candidateKeys(candidate);
  const matches = identities.filter((row) => overlaps(want, identityKeys(row)));
  if (matches.length === 0) {
    return null;
  }
  return [...matches].sort((a, b) => {
    const activeDiff = Number(b.active) - Number(a.active);
    if (activeDiff !== 0) {
      return activeDiff;
    }
    // Prefer SCIM/manual/SSO over a portal_import shell.
    const portalDiff = Number(a.source === 'portal_import') - Number(b.source === 'portal_import');
    if (portalDiff !== 0) {
      return portalDiff;
    }
    const rankDiff = emailRank(a.email) - emailRank(b.email);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a.userId.localeCompare(b.userId);
  })[0]!;
}

export type SeatSyncStats = {
  seatsAssigned: number;
  identitiesLinked: number;
  identitiesCreated: number;
};

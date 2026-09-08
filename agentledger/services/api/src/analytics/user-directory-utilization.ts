import type { UserUtilizationRow } from './user-value.types';

/** Minimal directory shape for merge (avoids circular import with AnalyticsService). */
export type DirectoryUserLike = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  resolved: boolean;
  total_spend_usd: number;
  calls: number;
  models: string[];
  model_breakdown: unknown[];
  status?: UserUtilizationRow['status'];
  has_seat?: boolean;
  utilization_score?: number;
  seat_monthly_cost_usd?: number;
  seat_provider?: string;
  plan_name?: string;
};

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Match directory row to a utilization row by email or user id. */
export function findUtilizationMatch(
  user: Pick<DirectoryUserLike, 'user_id' | 'email' | 'display_name'>,
  byKey: Map<string, UserUtilizationRow>,
): UserUtilizationRow | undefined {
  const keys = [norm(user.email), norm(user.user_id), norm(user.display_name)].filter(Boolean);
  for (const k of keys) {
    const hit = byKey.get(k);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

export function utilizationIndex(rows: UserUtilizationRow[]): Map<string, UserUtilizationRow> {
  const byKey = new Map<string, UserUtilizationRow>();
  for (const row of rows) {
    const keys = [norm(row.userId), norm(row.displayName)].filter(Boolean);
    for (const k of keys) {
      if (!byKey.has(k)) {
        byKey.set(k, row);
      }
    }
  }
  return byKey;
}

/**
 * Attach LARI utilization fields and append seat holders / inactive users who
 * have no metered spend yet (same presence model as Copilot member spend).
 */
export function mergeDirectoryWithUtilization<T extends DirectoryUserLike>(
  users: T[],
  utilRows: UserUtilizationRow[],
): T[] {
  const byKey = utilizationIndex(utilRows);
  const matched = new Set<UserUtilizationRow>();

  const enriched = users.map((u) => {
    const util = findUtilizationMatch(u, byKey);
    if (!util) {
      return u;
    }
    matched.add(util);
    return {
      ...u,
      status: util.status,
      has_seat: util.hasSeat,
      utilization_score: util.utilizationScore,
      seat_monthly_cost_usd: util.seatMonthlyCostUsd,
      seat_provider: util.seatProvider,
      plan_name: util.planName,
    } as T;
  });

  const extras: T[] = [];
  for (const util of utilRows) {
    if (matched.has(util)) {
      continue;
    }
    // Surface inactive/low-use seat holders and active users missing from spend directory.
    if (!util.hasSeat && util.calls <= 0 && util.sessions <= 0) {
      continue;
    }
    extras.push({
      user_id: util.userId,
      display_name: util.displayName || util.userId,
      email: util.userId.includes('@') ? util.userId : null,
      team: '',
      resolved: Boolean(util.displayName),
      total_spend_usd: util.costUsd,
      calls: util.calls,
      models: [],
      model_breakdown: [],
      status: util.status,
      has_seat: util.hasSeat,
      utilization_score: util.utilizationScore,
      seat_monthly_cost_usd: util.seatMonthlyCostUsd,
      seat_provider: util.seatProvider,
      plan_name: util.planName,
    } as unknown as T);
  }

  return [...enriched, ...extras];
}

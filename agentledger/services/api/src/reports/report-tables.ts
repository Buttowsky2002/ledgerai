import type { ModelSpendRow, UserSpendRow } from './executive-report.types';
import { usd } from './formatters';
import { UNATTRIBUTED_LABEL, UNASSIGNED_LABEL } from './identity-resolver';

export interface UserSpendTableRow {
  displayName: string;
  teamName: string;
  costUsd: number;
  pctOfTotal: number;
  topModel: string;
  calls: number;
}

export interface ModelSpendTableRow {
  model: string;
  provider: string;
  costUsd: number;
  pctOfTotal: number;
  calls: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return round2((part / total) * 100);
}

/** Map user_id -> highest-spend model in period. */
export function buildTopModelMap(rows: { userId: string; model: string; costUsd: number }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.userId)) map.set(row.userId, row.model);
  }
  return map;
}

/** Build executive person table: top N resolved users + unattributed/unassigned summary rows. */
export function buildUserSpendTable(
  resolved: UserSpendRow[],
  topModelByUserId: Map<string, string>,
  totalCost: number,
  topN = 20,
): UserSpendTableRow[] {
  const special = resolved.filter(
    (r) =>
      r.userId === '__unattributed__' ||
      r.userId === '__unassigned__' ||
      r.userId === '__others__' ||
      r.displayName === UNASSIGNED_LABEL ||
      r.displayName.startsWith(UNATTRIBUTED_LABEL),
  );
  const ranked = resolved
    .filter((r) => !special.includes(r))
    .filter((r) => r.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);

  const rows: UserSpendTableRow[] = ranked.slice(0, topN).map((r) => ({
    displayName: r.displayName,
    teamName: r.teamName,
    costUsd: r.costUsd,
    pctOfTotal: pct(r.costUsd, totalCost),
    topModel: topModelByUserId.get(r.userId) ?? '-',
    calls: r.calls,
  }));

  const others = ranked.slice(topN);
  if (others.length > 0) {
    const sum = usd(others.reduce((s, r) => s + r.costUsd, 0));
    rows.push({
      displayName: `All others (${others.length} users)`,
      teamName: '',
      costUsd: sum,
      pctOfTotal: pct(sum, totalCost),
      topModel: '-',
      calls: others.reduce((s, r) => s + r.calls, 0),
    });
  }

  for (const row of special.filter((r) => r.costUsd > 0)) {
    rows.push({
      displayName: row.displayName,
      teamName: row.teamName,
      costUsd: row.costUsd,
      pctOfTotal: pct(row.costUsd, totalCost),
      topModel: '-',
      calls: row.calls,
    });
  }
  return rows;
}

/** Flat model ranking across all platforms. */
export function buildModelSpendTable(models: ModelSpendRow[], totalCost: number): ModelSpendTableRow[] {
  return [...models]
    .filter((m) => m.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((m) => ({
      model: m.model,
      provider: m.provider,
      costUsd: m.costUsd,
      pctOfTotal: pct(m.costUsd, totalCost),
      calls: m.calls,
    }));
}

/** True when a single platform accounts for >= threshold of spend (skip near-empty donut). */
export function isSinglePlatformDominant(
  providers: { costUsd: number }[],
  threshold = 0.95,
): boolean {
  const active = providers.filter((p) => p.costUsd > 0);
  if (active.length <= 1) return true;
  const total = active.reduce((s, p) => s + p.costUsd, 0);
  if (total <= 0) return true;
  return active[0].costUsd / total >= threshold;
}

import type { CopilotSpendSummary } from '../github-copilot/github-copilot-analytics.service';
import { COPILOT_ANALYTICS_PROVIDER } from '../github-copilot/github-copilot-analytics.service';
import type {
  DailySpendRow,
  ModelSpendRow,
  ProviderSpendRow,
  SpendTotals,
} from './executive-report.types';
import { usd } from './formatters';

const n = (v: number) => usd(v);

/** Add provider_costs rows for platforms absent from spend_daily (e.g. OpenAI org billing). */
export function mergeProviderCostsSupplement(
  spendDailyProviders: ProviderSpendRow[],
  providerCosts: ProviderSpendRow[],
): { providers: ProviderSpendRow[]; addedCostUsd: number; addedCalls: number } {
  const providers = spendDailyProviders.map((p) => ({ ...p }));
  let addedCostUsd = 0;
  let addedCalls = 0;

  for (const row of providerCosts) {
    if (row.costUsd <= 0) continue;
    const existing = providers.find((p) => p.provider === row.provider);
    if (existing) continue;
    providers.push({ ...row });
    addedCostUsd += row.costUsd;
    addedCalls += row.calls;
  }

  providers.sort((a, b) => b.costUsd - a.costUsd);
  return { providers, addedCostUsd: n(addedCostUsd), addedCalls };
}

/** Fold GitHub Copilot Postgres spend into executive report aggregates (matches Overview). */
export function mergeCopilotSupplement(
  current: SpendTotals,
  providers: ProviderSpendRow[],
  models: ModelSpendRow[],
  spendTrend: DailySpendRow[],
  copilot: CopilotSpendSummary | null,
): {
  current: SpendTotals;
  providers: ProviderSpendRow[];
  models: ModelSpendRow[];
  spendTrend: DailySpendRow[];
} {
  if (!copilot || copilot.totalCostUsd <= 0) {
    return { current, providers, models, spendTrend };
  }

  const nextCurrent: SpendTotals = {
    ...current,
    costUsd: n(current.costUsd + copilot.totalCostUsd),
    calls: current.calls + copilot.totalCalls,
  };

  const nextProviders = providers.map((p) => ({ ...p }));
  const pIdx = nextProviders.findIndex(
    (p) =>
      p.provider === COPILOT_ANALYTICS_PROVIDER ||
      p.provider === copilot.platform.platform ||
      p.provider.toLowerCase().includes('copilot'),
  );
  if (pIdx >= 0) {
    nextProviders[pIdx].provider = COPILOT_ANALYTICS_PROVIDER;
    nextProviders[pIdx].costUsd = n(nextProviders[pIdx].costUsd + copilot.totalCostUsd);
    nextProviders[pIdx].calls += copilot.totalCalls;
  } else {
    nextProviders.push({
      provider: COPILOT_ANALYTICS_PROVIDER,
      costUsd: copilot.totalCostUsd,
      calls: copilot.totalCalls,
    });
  }
  nextProviders.sort((a, b) => b.costUsd - a.costUsd);

  const nextModels = models.map((m) => ({ ...m }));
  for (const row of copilot.modelMix) {
    const mIdx = nextModels.findIndex((m) => m.provider === row.provider && m.model === row.model);
    if (mIdx >= 0) {
      nextModels[mIdx].costUsd = n(nextModels[mIdx].costUsd + row.cost_usd);
      nextModels[mIdx].calls += row.calls;
    } else {
      nextModels.push({
        provider: row.provider,
        model: row.model,
        costUsd: row.cost_usd,
        calls: row.calls,
      });
    }
  }
  nextModels.sort((a, b) => b.costUsd - a.costUsd);

  const dayMap = new Map<string, number>();
  for (const row of spendTrend) {
    dayMap.set(row.day, row.costUsd);
  }
  for (const d of copilot.daily) {
    dayMap.set(d.day, n((dayMap.get(d.day) ?? 0) + d.cost_usd));
  }
  const nextTrend = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, costUsd]) => ({ day, costUsd }));

  return {
    current: nextCurrent,
    providers: nextProviders,
    models: nextModels,
    spendTrend: nextTrend,
  };
}

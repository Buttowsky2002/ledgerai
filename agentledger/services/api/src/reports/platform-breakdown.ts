import type { ModelSpendRow, PlatformBreakdownRow, ProviderSpendRow } from './executive-report.types';
import { usd } from './formatters';

const SUBSCRIPTION_HINTS = ['cursor', 'copilot', 'github_copilot'];

/** Infer subscription vs usage cost basis from provider slug. */
export function inferCostBasis(provider: string, explicit?: string | null): 'subscription' | 'usage' {
  if (explicit === 'subscription' || explicit === 'usage') return explicit;
  const p = provider.toLowerCase();
  if (SUBSCRIPTION_HINTS.some((h) => p.includes(h))) return 'subscription';
  return 'usage';
}

export function costBasisLabel(basis: 'subscription' | 'usage'): string {
  return basis === 'subscription' ? '(subscription)' : '(usage)';
}

/** Nest models under platforms and reconcile model sums to platform totals. */
export function buildPlatformBreakdown(
  providers: ProviderSpendRow[],
  models: ModelSpendRow[],
): PlatformBreakdownRow[] {
  const modelsByProvider = new Map<string, ModelSpendRow[]>();
  for (const m of models.filter((x) => x.costUsd > 0)) {
    const list = modelsByProvider.get(m.provider) ?? [];
    list.push(m);
    modelsByProvider.set(m.provider, list);
  }

  return providers
    .filter((p) => p.costUsd > 0)
    .map((p) => {
      const basis = inferCostBasis(p.provider, p.costBasis ?? null);
      const modelRows = (modelsByProvider.get(p.provider) ?? []).sort((a, b) => b.costUsd - a.costUsd);
      const modelSum = usd(modelRows.reduce((s, m) => s + m.costUsd, 0));
      const remainderUsd = usd(p.costUsd - modelSum);
      return {
        provider: p.provider,
        costUsd: p.costUsd,
        calls: p.calls,
        costBasis: basis,
        models: modelRows,
        remainderUsd: Math.abs(remainderUsd) >= 0.01 ? remainderUsd : 0,
      };
    });
}

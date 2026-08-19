/**
 * Deterministic spend "why" narratives — no LLM.
 *
 * Decomposes spend into model concentration, user concentration, seat waste,
 * and period-over-period shifts to answer "why are they spending that much?"
 */
import { linearTrendSlope, monthlyFactor, zScoreLast } from './lari-recommendations';
import type { ProductSpendDriver, ProductWorthVerdict } from './lari-product-worth.types';

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export type SpendTrend = 'up' | 'down' | 'flat' | 'insufficient';

export interface ProductSpendAnalysis {
  spendNarrative: string;
  spendTrend: SpendTrend;
  periodChangePct: number | null;
  periodChangeUsd: number | null;
  connectOutcomesPrompt: boolean;
}

export interface SpendNarrativeInput {
  product: string;
  totalSpendUsd: number;
  seatCostUsd: number;
  meteredSpendUsd: number;
  verdict: ProductWorthVerdict;
  confidenceBasis: string;
  attributedValueUsd: number;
  periodDays: number;
  topDrivers: ProductSpendDriver[];
  modelUsage: Array<{ provider: string; model: string; costUsd: number }>;
  priorModelUsage?: Array<{ provider: string; model: string; costUsd: number }>;
  priorTotalSpendUsd?: number;
  userUtilization: Array<{
    displayName: string;
    providers: string[];
    costUsd: number;
    status: string;
    hasSeat: boolean;
    seatProvider?: string;
  }>;
  dailySpend?: Array<{ day: string; costUsd: number }>;
}

function normalizeProvider(name: string): string {
  return name.trim().toLowerCase();
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function trendFromChange(changePct: number | null): SpendTrend {
  if (changePct === null) return 'insufficient';
  if (changePct >= 10) return 'up';
  if (changePct <= -10) return 'down';
  return 'flat';
}

/** Build a human-readable explanation of why spend looks the way it does. */
export function buildSpendNarrative(input: SpendNarrativeInput): ProductSpendAnalysis {
  const parts: string[] = [];
  const key = normalizeProvider(input.product);

  const periodChangeUsd =
    input.priorTotalSpendUsd !== undefined
      ? usd(input.totalSpendUsd - input.priorTotalSpendUsd)
      : null;
  const periodChangePct =
    input.priorTotalSpendUsd !== undefined && input.priorTotalSpendUsd > 0
      ? Math.round(((input.totalSpendUsd - input.priorTotalSpendUsd) / input.priorTotalSpendUsd) * 100)
      : null;

  if (periodChangePct !== null && Math.abs(periodChangePct) >= 10) {
    const dir = periodChangePct > 0 ? 'up' : 'down';
    parts.push(
      `Spend ${dir} ${Math.abs(periodChangePct)}% vs prior period (${periodChangeUsd! >= 0 ? '+' : ''}$${usd(Math.abs(periodChangeUsd!))}).`,
    );
  }

  const productModels = input.modelUsage
    .filter((m) => normalizeProvider(m.provider) === key)
    .sort((a, b) => b.costUsd - a.costUsd);
  if (productModels.length > 0 && input.meteredSpendUsd > 0) {
    const top = productModels[0]!;
    const topShare = pct(top.costUsd, input.meteredSpendUsd);
    if (topShare >= 40) {
      parts.push(`${topShare}% of metered spend ($${usd(top.costUsd)}) is on ${top.model}.`);
    }

    if (input.priorModelUsage && productModels.length >= 1) {
      const priorModels = input.priorModelUsage.filter((m) => normalizeProvider(m.provider) === key);
      const priorTop = priorModels.sort((a, b) => b.costUsd - a.costUsd)[0];
      const currentTop = top;
      if (
        priorTop &&
        priorTop.model !== currentTop.model &&
        currentTop.costUsd > priorTop.costUsd * 1.2
      ) {
        parts.push(
          `Usage shifted toward ${currentTop.model} (was ${priorTop.model} in prior period).`,
        );
      }
    }
  }

  const productUsers = input.userUtilization
    .filter(
      (u) =>
        u.providers.some((p) => normalizeProvider(p) === key) ||
        (u.seatProvider && normalizeProvider(u.seatProvider) === key),
    )
    .sort((a, b) => b.costUsd - a.costUsd);

  const inactiveWithSeat = productUsers.filter((u) => u.hasSeat && u.status === 'inactive');
  if (inactiveWithSeat.length > 0) {
    parts.push(
      `${inactiveWithSeat.length} inactive seat${inactiveWithSeat.length === 1 ? '' : 's'} (${inactiveWithSeat.map((u) => u.displayName).join(', ')}).`,
    );
  }

  if (productUsers.length >= 2 && input.meteredSpendUsd > 0) {
    const topThree = productUsers.slice(0, 3);
    const topThreeSpend = topThree.reduce((s, u) => s + u.costUsd, 0);
    const userShare = pct(topThreeSpend, input.meteredSpendUsd);
    if (userShare >= 50) {
      parts.push(
        `${Math.min(3, productUsers.length)} user${topThree.length === 1 ? '' : 's'} account for ${userShare}% of metered spend.`,
      );
    }
  }

  if (input.seatCostUsd > 0 && input.seatCostUsd > input.meteredSpendUsd * 0.5) {
    parts.push(
      `Seat licenses ($${usd(input.seatCostUsd)}/period) exceed metered usage ($${usd(input.meteredSpendUsd)}) — review unused seats.`,
    );
  }

  if (input.dailySpend && input.dailySpend.length >= 7) {
    const values = input.dailySpend.map((d) => d.costUsd);
    const z = zScoreLast(values);
    const slope = linearTrendSlope(values);
    if (z >= 2 && slope > 0) {
      parts.push(`Daily spend trending up (z-score ${z.toFixed(1)}).`);
    }
  }

  const connectOutcomesPrompt =
    input.attributedValueUsd <= 0 &&
    (input.confidenceBasis === 'utilization' ||
      input.confidenceBasis === 'none' ||
      input.verdict === 'insufficient_data');

  if (connectOutcomesPrompt) {
    parts.push(
      'Connect GitHub, Jira, or Zendesk outcomes to unlock outcome-based ROI for this product.',
    );
  }

  if (parts.length === 0 && input.topDrivers.length > 0) {
    parts.push(
      `Top spend drivers: ${input.topDrivers.map((d) => `${d.label} ($${usd(d.costUsd)})`).join(', ')}.`,
    );
  }

  if (parts.length === 0) {
    parts.push(`$${usd(input.totalSpendUsd)} total spend in range with no dominant driver identified.`);
  }

  return {
    spendNarrative: parts.join(' '),
    spendTrend: trendFromChange(periodChangePct),
    periodChangePct,
    periodChangeUsd,
    connectOutcomesPrompt,
  };
}

export interface BudgetSuggestionEntry {
  scope: 'tenant' | 'product' | 'agent';
  scopeId: string;
  label: string;
  currentRunRateUsd: number;
  recommendedBudgetUsd: number;
  deltaUsd: number;
  rationale: string;
  verdict?: ProductWorthVerdict;
}

export interface BudgetSuggestionsInput {
  periodDays: number;
  products: Array<{
    product: string;
    monthlyRunRateUsd: number;
    recommendedBudgetUsd: number | null;
    verdict: ProductWorthVerdict;
    spendNarrative: string;
  }>;
  agents?: Array<{
    agentId: string;
    costUsd: number;
    valueUsd: number;
    lari: number;
    recommendation: string;
  }>;
}

/** Assemble tenant-, product-, and agent-level budget suggestions. */
export function buildBudgetSuggestions(input: BudgetSuggestionsInput): BudgetSuggestionEntry[] {
  const factor = monthlyFactor(input.periodDays);
  const suggestions: BudgetSuggestionEntry[] = [];

  let tenantRunRate = 0;
  let tenantRecommended = 0;

  for (const p of input.products) {
    if (p.recommendedBudgetUsd === null || p.monthlyRunRateUsd <= 0) continue;
    tenantRunRate += p.monthlyRunRateUsd;
    tenantRecommended += p.recommendedBudgetUsd;

    const delta = p.monthlyRunRateUsd - p.recommendedBudgetUsd;
    if (Math.abs(delta) < p.monthlyRunRateUsd * 0.05) continue;

    suggestions.push({
      scope: 'product',
      scopeId: p.product,
      label: p.product,
      currentRunRateUsd: p.monthlyRunRateUsd,
      recommendedBudgetUsd: p.recommendedBudgetUsd,
      deltaUsd: usd(delta),
      rationale:
        p.verdict === 'worth_it'
          ? 'Proven ROI — allocate 10% headroom above current run-rate.'
          : p.verdict === 'not_worth_it'
            ? `Underperforming product — ${p.spendNarrative.split('.')[0]}.`
            : `Optimization opportunity — ${p.spendNarrative.split('.')[0]}.`,
      verdict: p.verdict,
    });
  }

  if (tenantRunRate > 0 && tenantRecommended > 0) {
    const tenantDelta = tenantRunRate - tenantRecommended;
    if (Math.abs(tenantDelta) >= tenantRunRate * 0.05) {
      suggestions.unshift({
        scope: 'tenant',
        scopeId: 'portfolio',
        label: 'Total AI portfolio',
        currentRunRateUsd: usd(tenantRunRate),
        recommendedBudgetUsd: usd(tenantRecommended),
        deltaUsd: usd(tenantDelta),
        rationale:
          tenantDelta > 0
            ? 'Aggregate recommended caps reflect reclaimable seats and underperforming products.'
            : 'Portfolio ROI supports modest budget increase across proven products.',
      });
    }
  }

  for (const agent of input.agents ?? []) {
    const monthlyCost = usd(agent.costUsd * factor);
    if (monthlyCost <= 0) continue;

    let recommended: number;
    let rationale: string;

    if (agent.recommendation === 'retire' || agent.recommendation === 'pause') {
      recommended = 0;
      rationale = `LARI recommends ${agent.recommendation} — $${usd(agent.valueUsd)} value on $${usd(agent.costUsd)} cost.`;
    } else if (agent.recommendation === 'scale') {
      recommended = usd(monthlyCost * 1.25);
      rationale = `Strong LARI (${agent.lari.toFixed(2)}×) — allocate headroom to scale.`;
    } else if (agent.recommendation === 'optimize') {
      recommended = usd(monthlyCost * 0.8);
      rationale = `High cost relative to value — target 20% reduction via model/run optimization.`;
    } else {
      continue;
    }

    const delta = monthlyCost - recommended;
    if (Math.abs(delta) < monthlyCost * 0.05) continue;

    suggestions.push({
      scope: 'agent',
      scopeId: agent.agentId,
      label: agent.agentId,
      currentRunRateUsd: monthlyCost,
      recommendedBudgetUsd: recommended,
      deltaUsd: usd(delta),
      rationale,
    });
  }

  return suggestions.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
}

/** Spend-driver recommendations with narrative "why" field. */
export function spendDriverRecs(
  products: Array<{
    product: string;
    totalSpendUsd: number;
    spendNarrative: string;
    spendTrend: SpendTrend;
    periodChangePct: number | null;
    connectOutcomesPrompt: boolean;
  }>,
): import('./lari-recommendations.types').LariActionableRecommendation[] {
  const recs: import('./lari-recommendations.types').LariActionableRecommendation[] = [];

  for (const p of products) {
    if (p.totalSpendUsd < 50) continue;

    const isSpike = p.spendTrend === 'up' && (p.periodChangePct ?? 0) >= 25;
    const needsOutcome = p.connectOutcomesPrompt;

    if (!isSpike && !needsOutcome) continue;

    const id = isSpike
      ? `spend-driver-spike-${normalizeProvider(p.product)}`
      : `spend-driver-outcomes-${normalizeProvider(p.product)}`;

    recs.push({
      id,
      priority: isSpike ? 'high' : 'medium',
      category: 'spend_driver',
      title: isSpike
        ? `Spend spike on ${p.product}`
        : `Missing outcome data for ${p.product}`,
      message: p.spendNarrative,
      action: isSpike
        ? 'Review top drivers and model selection; set a budget alert at recommended cap.'
        : 'Connect an outcome source (GitHub merged PRs, Jira closed issues) to validate whether spend is worth it.',
      estimatedImpactUsd: usd(p.totalSpendUsd),
      mlScore: isSpike ? 70 : 40,
      evidence: [
        `product=${p.product}`,
        `trend=${p.spendTrend}`,
        ...(p.periodChangePct !== null ? [`period_change_pct=${p.periodChangePct}`] : []),
        `connect_outcomes=${needsOutcome}`,
      ],
      relatedEntity: { type: 'provider', id: p.product },
    });
  }

  return recs;
}

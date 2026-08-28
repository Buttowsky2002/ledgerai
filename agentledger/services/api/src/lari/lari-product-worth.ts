/**
 * Product Worth Scorecard — deterministic verdict on whether AI product spend is justified.
 *
 * Combines outcome-attributed value (when available) with utilization signals for
 * import-only tenants. No LLM calls; all figures are advisory estimates.
 */
import type { LariActionableRecommendation } from './lari-recommendations.types';
import { compositeMlScore, monthlyFactor, priorityFromScore, utilizationRatio } from './lari-recommendations';
import {
  buildBudgetSuggestions,
  buildSpendNarrative,
} from './lari-spend-narrative';
import {
  buildDataCoverage,
  buildOutcomeSourceStatus,
  enrichProductsWithSources,
  importParityNarrative,
} from './lari-import-coverage';
import type {
  BudgetSuggestionEntry,
  OutcomeStats,
  ProductConfidenceBasis,
  ProductSpendDriver,
  ProductWorthEntry,
  ProductWorthInput,
  ProductWorthResponse,
  ProductWorthVerdict,
} from './lari-product-worth.types';

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

const VERDICT_RANK: Record<ProductWorthVerdict, number> = {
  not_worth_it: 0,
  insufficient_data: 1,
  marginal: 2,
  worth_it: 3,
};

function normalizeProvider(name: string): string {
  return name.trim().toLowerCase();
}

function seatCostForProvider(
  provider: string,
  plans: ProductWorthInput['subscriptionPlans'],
  periodDays: number,
): number {
  const key = normalizeProvider(provider);
  const factor = monthlyFactor(periodDays);
  return plans
    .filter((p) => normalizeProvider(p.provider) === key)
    .reduce((sum, p) => sum + (p.contractMonthlyCost / factor), 0);
}

function utilizationForProvider(
  provider: string,
  plans: ProductWorthInput['subscriptionPlans'],
  users: ProductWorthInput['userUtilization'],
): { utilization: number; inactiveSeats: number; seatCost: number } {
  const key = normalizeProvider(provider);
  const plan = plans.find((p) => normalizeProvider(p.provider) === key);
  if (plan && plan.seatsPurchased > 0) {
    return {
      utilization: utilizationRatio(plan.activeSeats, plan.seatsPurchased),
      inactiveSeats: Math.max(0, plan.seatsPurchased - plan.activeSeats),
      seatCost: plan.contractMonthlyCost,
    };
  }

  const providerUsers = users.filter(
    (u) =>
      u.providers.some((p) => normalizeProvider(p) === key) ||
      (u.seatProvider && normalizeProvider(u.seatProvider) === key),
  );
  if (providerUsers.length === 0) {
    return { utilization: 1, inactiveSeats: 0, seatCost: 0 };
  }
  const active = providerUsers.filter((u) => u.status === 'active').length;
  const inactiveSeats = providerUsers.filter((u) => u.hasSeat && u.status === 'inactive').length;
  return {
    utilization: utilizationRatio(active, providerUsers.length),
    inactiveSeats,
    seatCost: providerUsers.reduce((s, u) => s + u.seatMonthlyCostUsd, 0),
  };
}

function topDriversForProvider(
  provider: string,
  input: ProductWorthInput,
  util: ReturnType<typeof utilizationForProvider>,
): ProductSpendDriver[] {
  const key = normalizeProvider(provider);
  const drivers: ProductSpendDriver[] = [];

  const models = input.modelUsage
    .filter((m) => normalizeProvider(m.provider) === key)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 2);
  for (const m of models) {
    drivers.push({
      type: 'model',
      label: m.model,
      costUsd: usd(m.costUsd),
      detail: `${m.provider}/${m.model}`,
    });
  }

  const users = input.userUtilization
    .filter(
      (u) =>
        u.providers.some((p) => normalizeProvider(p) === key) ||
        (u.seatProvider && normalizeProvider(u.seatProvider) === key),
    )
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 2);
  for (const u of users) {
    drivers.push({
      type: 'user',
      label: u.displayName,
      costUsd: usd(u.costUsd),
      detail: u.status !== 'active' ? `status=${u.status}` : undefined,
    });
  }

  if (util.inactiveSeats > 0 && util.seatCost > 0) {
    drivers.push({
      type: 'seat_waste',
      label: `${util.inactiveSeats} inactive seat${util.inactiveSeats === 1 ? '' : 's'}`,
      costUsd: usd(util.seatCost),
    });
  }

  return drivers.sort((a, b) => b.costUsd - a.costUsd).slice(0, 3);
}

function deriveVerdict(
  worthRatio: number | null,
  attributedValue: number,
  util: ReturnType<typeof utilizationForProvider>,
  calls: number,
  copilotRoiPct: number | undefined,
  provider: string,
): { verdict: ProductWorthVerdict; confidence: number; basis: ProductConfidenceBasis } {
  const isCopilot = normalizeProvider(provider).includes('copilot');

  if (attributedValue > 0 && worthRatio !== null) {
    const basis: ProductConfidenceBasis = 'outcomes';
    const confidence = Math.min(95, 55 + Math.round(worthRatio * 20));
    if (worthRatio >= 1.0) {return { verdict: 'worth_it', confidence, basis };}
    if (worthRatio >= 0.5) {return { verdict: 'marginal', confidence: confidence - 10, basis };}
    return { verdict: 'not_worth_it', confidence, basis };
  }

  if (isCopilot && copilotRoiPct !== undefined) {
    const basis: ProductConfidenceBasis = 'productivity_proxy';
    const confidence = 45;
    if (copilotRoiPct >= 20) {return { verdict: 'worth_it', confidence: 60, basis };}
    if (copilotRoiPct >= 0) {return { verdict: 'marginal', confidence, basis };}
    return { verdict: 'not_worth_it', confidence: 55, basis };
  }

  if (calls > 0 || util.utilization > 0) {
    const basis: ProductConfidenceBasis = util.utilization > 0 && attributedValue > 0 ? 'mixed' : 'utilization';
    const confidence = Math.round(25 + util.utilization * 35 + (calls > 0 ? 15 : 0));
    if (util.utilization >= 0.65 && calls > 10) {
      return { verdict: 'marginal', confidence, basis };
    }
    if (util.utilization < 0.35 || util.inactiveSeats >= 2) {
      return { verdict: 'not_worth_it', confidence: Math.max(confidence, 40), basis };
    }
    return { verdict: 'insufficient_data', confidence: Math.min(confidence, 35), basis: 'none' };
  }

  return { verdict: 'insufficient_data', confidence: 15, basis: 'none' };
}

function recommendedBudget(
  verdict: ProductWorthVerdict,
  monthlyRunRate: number,
  util: ReturnType<typeof utilizationForProvider>,
  reclaimableMonthly: number,
): number | null {
  if (monthlyRunRate <= 0) {return null;}

  switch (verdict) {
    case 'not_worth_it':
      return usd(Math.max(0, monthlyRunRate * util.utilization - reclaimableMonthly * 0.5));
    case 'marginal':
      return usd(Math.max(0, monthlyRunRate - reclaimableMonthly));
    case 'worth_it':
      return usd(monthlyRunRate * 1.1);
    case 'insufficient_data':
      return usd(monthlyRunRate);
  }
}

/** Build per-product worth scorecard from assembled tenant data. */
export function buildProductWorthScorecard(
  from: string,
  to: string,
  input: ProductWorthInput,
): ProductWorthResponse {
  const factor = monthlyFactor(input.periodDays);
  const valueByProvider = new Map(
    input.providerRankings.map((r) => [normalizeProvider(r.provider), r]),
  );

  const productKeys = new Set<string>();
  for (const p of input.providerSpend) {productKeys.add(normalizeProvider(p.provider));}
  for (const p of input.subscriptionPlans) {productKeys.add(normalizeProvider(p.provider));}

  const products: ProductWorthEntry[] = [];

  for (const key of productKeys) {
    const spendRow = input.providerSpend.find((p) => normalizeProvider(p.provider) === key);
    const ranking = valueByProvider.get(key);
    const displayName = spendRow?.provider ?? ranking?.provider ?? key;

    const meteredSpend = spendRow?.costUsd ?? 0;
    const seatCost = seatCostForProvider(displayName, input.subscriptionPlans, input.periodDays);
    const totalSpend = usd(meteredSpend + seatCost);
    if (totalSpend <= 0) {continue;}

    const attributedValue = ranking?.attributedValueUsd ?? 0;
    const worthRatio =
      totalSpend > 0 && attributedValue > 0 ? usd(attributedValue / totalSpend) : null;
    const util = utilizationForProvider(displayName, input.subscriptionPlans, input.userUtilization);
    const calls = spendRow?.calls ?? 0;

    const { verdict, confidence, basis } = deriveVerdict(
      worthRatio,
      attributedValue,
      util,
      calls,
      input.copilotRoiPct,
      displayName,
    );

    const monthlyRunRate = usd(totalSpend * factor);
    const reclaimable = util.inactiveSeats > 0 ? util.seatCost : 0;
    const topDrivers = topDriversForProvider(displayName, input, util);

    const priorRow = input.priorProviderSpend?.find(
      (p) => normalizeProvider(p.provider) === key,
    );
    const priorTotal =
      priorRow !== undefined
        ? usd(priorRow.costUsd + seatCostForProvider(displayName, input.subscriptionPlans, input.periodDays))
        : undefined;

    const narrative = buildSpendNarrative({
      product: displayName,
      totalSpendUsd: totalSpend,
      seatCostUsd: usd(seatCost),
      meteredSpendUsd: usd(meteredSpend),
      verdict,
      confidenceBasis: basis,
      attributedValueUsd: attributedValue,
      periodDays: input.periodDays,
      topDrivers,
      modelUsage: input.modelUsage,
      priorModelUsage: input.priorModelUsage,
      priorTotalSpendUsd: priorTotal,
      userUtilization: input.userUtilization,
      dailySpend: input.dailySpend,
    });

    products.push({
      product: displayName,
      totalSpendUsd: totalSpend,
      seatCostUsd: usd(seatCost),
      meteredSpendUsd: usd(meteredSpend),
      attributedValueUsd: attributedValue,
      worthRatio,
      verdict,
      confidenceScore: confidence,
      confidenceBasis: basis,
      monthlyRunRateUsd: monthlyRunRate,
      recommendedBudgetUsd: recommendedBudget(verdict, monthlyRunRate, util, reclaimable),
      topDrivers,
      spendNarrative: narrative.spendNarrative,
      spendTrend: narrative.spendTrend,
      periodChangePct: narrative.periodChangePct,
      periodChangeUsd: narrative.periodChangeUsd,
      connectOutcomesPrompt: narrative.connectOutcomesPrompt,
    });
  }

  products.sort((a, b) => {
    const vr = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
    return vr !== 0 ? vr : b.totalSpendUsd - a.totalSpendUsd;
  });

  const totalSpendUsd = usd(products.reduce((s, p) => s + p.totalSpendUsd, 0));
  const totalAttributedValueUsd = usd(products.reduce((s, p) => s + p.attributedValueUsd, 0));

  const budgetSuggestions: BudgetSuggestionEntry[] = buildBudgetSuggestions({
    periodDays: input.periodDays,
    products: products.map((p) => ({
      product: p.product,
      monthlyRunRateUsd: p.monthlyRunRateUsd,
      recommendedBudgetUsd: p.recommendedBudgetUsd,
      verdict: p.verdict,
      spendNarrative: p.spendNarrative,
    })),
    agents: input.agents,
  });

  const enrichedProducts = enrichProductsWithSources(products, input.spendBySource ?? new Map());

  const dataCoverage = buildDataCoverage({
    products: enrichedProducts,
    spendBySource: input.spendBySource ?? new Map(),
    outcomeStats: input.outcomeStats ?? emptyOutcomeStats(),
    importStats: input.importStats ?? { portalImportRuns: 0, bulkImportEvents: 0 },
    connectors: input.connectors ?? { billingConnectors: [], outcomeConnectors: [] },
  });
  const outcomeSources = buildOutcomeSourceStatus(
    input.connectors ?? { billingConnectors: [], outcomeConnectors: [] },
  );
  const importParityMessage = importParityNarrative(dataCoverage);

  return {
    from,
    to,
    products: enrichedProducts,
    budgetSuggestions,
    dataCoverage,
    outcomeSources,
    importParityMessage,
    summary: {
      productCount: products.length,
      worthItCount: products.filter((p) => p.verdict === 'worth_it').length,
      notWorthItCount: products.filter((p) => p.verdict === 'not_worth_it').length,
      totalSpendUsd,
      totalAttributedValueUsd,
      portfolioWorthRatio:
        totalSpendUsd > 0 && totalAttributedValueUsd > 0
          ? usd(totalAttributedValueUsd / totalSpendUsd)
          : null,
    },
  };
}

function emptyOutcomeStats(): OutcomeStats {
  return {
    totalOutcomes: 0,
    importOutcomes: 0,
    connectorOutcomes: 0,
    apiOutcomes: 0,
    totalValueUsd: 0,
    roiLinkedOutcomes: 0,
    roiLinkedValueUsd: 0,
    headlineEligibleOutcomes: 0,
  };
}

const VERDICT_LABEL: Record<ProductWorthVerdict, string> = {
  worth_it: 'Worth it',
  marginal: 'Marginal',
  not_worth_it: 'Not worth it',
  insufficient_data: 'Insufficient data',
};

/** Product-level worth verdicts as LARI recommendations. */
export function productWorthRecs(
  scorecard: ProductWorthResponse,
): LariActionableRecommendation[] {
  const recs: LariActionableRecommendation[] = [];

  for (const product of scorecard.products) {
    if (product.verdict === 'worth_it' && product.worthRatio !== null && product.worthRatio >= 1.5) {
      recs.push({
        id: `product-worth-scale-${normalizeProvider(product.product)}`,
        priority: 'low',
        category: 'product_worth',
        title: `${product.product} delivers strong ROI`,
        message: `${VERDICT_LABEL[product.verdict]} — $${usd(product.attributedValueUsd)} attributed value on $${usd(product.totalSpendUsd)} spend (${product.worthRatio.toFixed(2)}× value/$).`,
        action: 'Maintain or expand budget; use as benchmark for similar workloads.',
        mlScore: 25,
        evidence: [
          `product=${product.product}`,
          `verdict=${product.verdict}`,
          `worth_ratio=${product.worthRatio}`,
          `confidence=${product.confidenceScore}`,
          `basis=${product.confidenceBasis}`,
        ],
        relatedEntity: { type: 'provider', id: product.product },
      });
      continue;
    }

    if (product.verdict !== 'marginal' && product.verdict !== 'not_worth_it') {continue;}

    const mlScore = compositeMlScore([
      { weight: 0.5, value: product.verdict === 'not_worth_it' ? 1 : 0.6 },
      { weight: 0.3, value: Math.min(1, product.totalSpendUsd / 1000) },
      { weight: 0.2, value: 1 - product.confidenceScore / 100 },
    ]);

    recs.push({
      id: `product-worth-${product.verdict}-${normalizeProvider(product.product)}`,
      priority: priorityFromScore(mlScore),
      category: 'product_worth',
      title: `${product.product} — ${VERDICT_LABEL[product.verdict].toLowerCase()}`,
      message:
        product.attributedValueUsd > 0
          ? `$${usd(product.attributedValueUsd)} value on $${usd(product.totalSpendUsd)} spend (${product.worthRatio?.toFixed(2) ?? '—'}× value/$). ${product.spendNarrative}`
          : `${product.spendNarrative}`,
      action:
        product.verdict === 'not_worth_it'
          ? 'Reduce seats, switch models, or decommission; connect outcome sources to confirm before renewal.'
          : 'Optimize model selection and seat allocation; connect GitHub/Jira outcomes to validate ROI.',
      estimatedImpactUsd: usd(product.totalSpendUsd),
      estimatedSavingsUsd:
        product.verdict === 'not_worth_it'
          ? usd(product.monthlyRunRateUsd * 0.4)
          : usd(product.monthlyRunRateUsd * 0.15),
      mlScore,
      evidence: [
        `product=${product.product}`,
        `verdict=${product.verdict}`,
        `confidence=${product.confidenceScore}`,
        `basis=${product.confidenceBasis}`,
        ...(product.worthRatio !== null ? [`worth_ratio=${product.worthRatio}`] : []),
      ],
      relatedEntity: { type: 'provider', id: product.product },
    });
  }

  return recs;
}

/** Suggested monthly budget caps per product. */
export function budgetSuggestionRecs(
  scorecard: ProductWorthResponse,
): LariActionableRecommendation[] {
  const recs: LariActionableRecommendation[] = [];

  for (const product of scorecard.products) {
    if (product.recommendedBudgetUsd === null) {continue;}
    if (product.monthlyRunRateUsd <= 0) {continue;}

    const delta = product.monthlyRunRateUsd - product.recommendedBudgetUsd;
    const isCut = delta > product.monthlyRunRateUsd * 0.05;
    const isIncrease = product.recommendedBudgetUsd > product.monthlyRunRateUsd * 1.05;

    if (!isCut && !isIncrease) {continue;}

    const mlScore = compositeMlScore([
      { weight: 0.5, value: Math.min(1, Math.abs(delta) / 500) },
      { weight: 0.5, value: product.verdict === 'not_worth_it' ? 1 : 0.5 },
    ]);

    recs.push({
      id: `budget-suggestion-${normalizeProvider(product.product)}`,
      priority: priorityFromScore(mlScore),
      category: 'budget_suggestion',
      title: `Budget cap for ${product.product}`,
      message: `Current run-rate $${usd(product.monthlyRunRateUsd)}/mo → recommended $${usd(product.recommendedBudgetUsd)}/mo (${isCut ? 'reduce' : 'increase'} $${usd(Math.abs(delta))}/mo).`,
      action: isCut
        ? 'Set a monthly budget alert at the recommended cap and review seat/model usage monthly.'
        : 'Allocate headroom for proven ROI — set budget alert 10% above current run-rate.',
      estimatedSavingsUsd: isCut ? usd(delta) : undefined,
      estimatedImpactUsd: usd(product.monthlyRunRateUsd),
      mlScore,
      evidence: [
        `product=${product.product}`,
        `run_rate=${product.monthlyRunRateUsd}`,
        `recommended=${product.recommendedBudgetUsd}`,
        `verdict=${product.verdict}`,
      ],
      relatedEntity: { type: 'provider', id: product.product },
    });
  }

  return recs;
}

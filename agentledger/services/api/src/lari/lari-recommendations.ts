/**
 * LARI actionable recommendations — deterministic statistical ML engine.
 *
 * Uses percentile ranking, z-score anomaly detection, utilization scoring, and
 * efficiency regression — no LLM calls and no randomness (ADR-047). Financial
 * figures are advisory estimates traced in `evidence`.
 */
import {
  AgentEconomicsHighlight,
  LariActionableRecommendation,
  LariRecommendationsInput,
  ProviderValueRanking,
  RecommendationPriority,
} from './lari-recommendations.types';
import { Recommendation } from './lari.types';
import { UTILIZATION_CAVEAT } from '../analytics/user-value.util';
import {
  blendedRate,
  projectedCostUsd,
  resolveModelRate,
  substitutionCandidates,
} from './model-equivalence';

const PRIORITY_RANK: Record<RecommendationPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

/** Seat utilization in [0,1]. */
export function utilizationRatio(active: number, purchased: number): number {
  if (purchased <= 0) return 1;
  return Math.min(1, Math.max(0, active / purchased));
}

/** Z-score for the last value in a series; returns 0 when variance is zero. */
export function zScoreLast(values: number[]): number {
  if (values.length < 3) return 0;
  const slice = values.slice(0, -1);
  const last = values[values.length - 1]!;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (last - mean) / std : 0;
}

/** Simple OLS slope for evenly spaced points (trend per step). */
export function linearTrendSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i]! - yMean);
    den += (i - xMean) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/** Percentile rank in [0,100] — higher = better efficiency. */
export function percentileRank(score: number, scores: number[]): number {
  if (scores.length === 0) return 50;
  const sorted = [...scores].sort((a, b) => a - b);
  const below = sorted.filter((s) => s < score).length;
  return Math.round((below / sorted.length) * 100);
}

/** Composite ML urgency score from normalized factors in [0,1]. */
export function compositeMlScore(factors: { weight: number; value: number }[]): number {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  if (totalWeight <= 0) return 0;
  const score =
    factors.reduce((s, f) => s + f.weight * Math.min(1, Math.max(0, f.value)), 0) / totalWeight;
  return Math.round(score * 100);
}

function priorityFromScore(score: number): RecommendationPriority {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function monthlyFactor(periodDays: number): number {
  return periodDays > 0 ? 30 / periodDays : 1;
}

/** Rank providers by attributed value per dollar spent. */
export function rankProviders(
  providerSpend: Array<{ provider: string; costUsd: number; calls: number }>,
  agentProviderSpend: Array<{ agentId: string; provider: string; costUsd: number }>,
  agentEconomics: AgentEconomicsHighlight[],
): ProviderValueRanking[] {
  const valueByAgent = new Map(agentEconomics.map((a) => [a.agentId, a.valueUsd]));
  const valueByProvider = new Map<string, number>();

  for (const row of agentProviderSpend) {
    const agentValue = valueByAgent.get(row.agentId) ?? 0;
    const agentTotal = agentProviderSpend
      .filter((r) => r.agentId === row.agentId)
      .reduce((s, r) => s + r.costUsd, 0);
    const share = agentTotal > 0 ? row.costUsd / agentTotal : 0;
    valueByProvider.set(row.provider, (valueByProvider.get(row.provider) ?? 0) + agentValue * share);
  }

  const rows = providerSpend.map((p) => {
    const attributedValueUsd = valueByProvider.get(p.provider) ?? 0;
    const valuePerDollar = p.costUsd > 0 ? attributedValueUsd / p.costUsd : 0;
    return { ...p, attributedValueUsd, valuePerDollar };
  });

  const vpds = rows.map((r) => r.valuePerDollar);
  const ranked = rows
    .map((r) => ({
      provider: r.provider,
      costUsd: usd(r.costUsd),
      calls: r.calls,
      attributedValueUsd: usd(r.attributedValueUsd),
      valuePerDollar: Math.round(r.valuePerDollar * 1000) / 1000,
      efficiencyScore: percentileRank(r.valuePerDollar, vpds),
      rank: 0,
    }))
    .sort((a, b) => b.valuePerDollar - a.valuePerDollar);

  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
  return ranked;
}

function seatRecommendations(input: LariRecommendationsInput): LariActionableRecommendation[] {
  const recs: LariActionableRecommendation[] = [];
  const { seatStats, subscriptionPlans } = input;
  const util = utilizationRatio(seatStats.active, seatStats.purchased);
  const unused = Math.max(0, seatStats.purchased - seatStats.active);

  if (seatStats.purchased > 0 && unused > 0) {
    const monthlyWaste = subscriptionPlans.reduce((s, p) => {
      const planUnused = Math.max(0, p.seatsPurchased - p.activeSeats);
      const perSeat = p.seatsPurchased > 0 ? p.contractMonthlyCost / p.seatsPurchased : p.monthlyPricePerUser;
      return s + planUnused * perSeat;
    }, 0);
    const mlScore = compositeMlScore([
      { weight: 0.5, value: 1 - util },
      { weight: 0.3, value: Math.min(1, unused / seatStats.purchased) },
      { weight: 0.2, value: monthlyWaste > 500 ? 1 : monthlyWaste / 500 },
    ]);
    recs.push({
      id: 'remove-unused-seats',
      priority: priorityFromScore(mlScore),
      category: 'seat_optimization',
      title: `Remove ${unused} unused seat${unused === 1 ? '' : 's'}`,
      message: `${seatStats.purchased} seats purchased but only ${seatStats.active} active (${Math.round(util * 100)}% utilization).`,
      action: 'Deprovision unused seats in your provider admin console or reduce contract seat count at renewal.',
      estimatedSavingsUsd: usd(monthlyWaste),
      mlScore,
      evidence: [
        `purchased=${seatStats.purchased}, active=${seatStats.active}`,
        `utilization=${Math.round(util * 100)}%`,
        `estimated monthly waste=$${usd(monthlyWaste)}`,
      ],
    });
  }

  if (input.copilotInactiveSeats && input.copilotInactiveSeats > 0) {
    const seatCost = input.copilotSeatMonthlyCost ?? 19;
    const waste = input.copilotInactiveSeats * seatCost;
    const mlScore = compositeMlScore([
      { weight: 0.6, value: Math.min(1, input.copilotInactiveSeats / 10) },
      { weight: 0.4, value: Math.min(1, waste / 500) },
    ]);
    recs.push({
      id: 'copilot-inactive-seats',
      priority: priorityFromScore(mlScore),
      category: 'seat_optimization',
      title: `Review ${input.copilotInactiveSeats} inactive Copilot seat${input.copilotInactiveSeats === 1 ? '' : 's'}`,
      message: `GitHub Copilot seats with 14+ days of inactivity — estimated $${usd(waste)}/month waste.`,
      action: 'Remove or reassign inactive Copilot seats before the next billing cycle.',
      estimatedSavingsUsd: usd(waste),
      mlScore,
      evidence: [`inactive_copilot_seats=${input.copilotInactiveSeats}`, `seat_price=$${seatCost}/mo`],
      relatedEntity: { type: 'provider', id: 'github_copilot' },
    });
  }

  for (const plan of subscriptionPlans) {
    if (plan.seatsPurchased > 0 && plan.activeSeats === 0) {
      recs.push({
        id: `plan-no-active-${plan.planId}`,
        priority: 'high',
        category: 'seat_optimization',
        title: `${plan.provider} plan has no active seats`,
        message: `"${plan.planName}" costs $${usd(plan.contractMonthlyCost)}/month with zero active assignments.`,
        action: 'Cancel the plan or assign seats to active users.',
        estimatedSavingsUsd: usd(plan.contractMonthlyCost),
        mlScore: 75,
        evidence: [`plan=${plan.planName}`, `contract_monthly=$${usd(plan.contractMonthlyCost)}`],
        relatedEntity: { type: 'plan', id: plan.planId },
      });
    }
  }

  return recs;
}

function planRecommendations(
  input: LariRecommendationsInput,
  rankings: ProviderValueRanking[],
): LariActionableRecommendation[] {
  const recs: LariActionableRecommendation[] = [];
  const { providerSpend, dailySpend, periodDays } = input;

  if (providerSpend.length >= 2) {
    const withCalls = providerSpend.filter((p) => p.calls > 0);
    const costPerCall = withCalls.map((p) => ({
      provider: p.provider,
      cpc: p.costUsd / p.calls,
      costUsd: p.costUsd,
    }));
    costPerCall.sort((a, b) => a.cpc - b.cpc);
    const cheapest = costPerCall[0];
    const expensive = costPerCall[costPerCall.length - 1];
    if (cheapest && expensive && expensive.cpc > cheapest.cpc * 1.5 && expensive.costUsd > 100) {
      const savings = (expensive.cpc - cheapest.cpc) * (providerSpend.find((p) => p.provider === expensive.provider)?.calls ?? 0);
      const monthlySavings = savings * monthlyFactor(periodDays);
      const mlScore = compositeMlScore([
        { weight: 0.5, value: Math.min(1, (expensive.cpc - cheapest.cpc) / expensive.cpc) },
        { weight: 0.3, value: Math.min(1, expensive.costUsd / 1000) },
        { weight: 0.2, value: Math.min(1, monthlySavings / 500) },
      ]);
      recs.push({
        id: 'switch-lower-cost-provider',
        priority: priorityFromScore(mlScore),
        category: 'plan_optimization',
        title: `Route workloads from ${expensive.provider} to ${cheapest.provider}`,
        message: `${expensive.provider} costs $${usd(expensive.cpc)}/call vs $${usd(cheapest.cpc)}/call on ${cheapest.provider} (${Math.round(((expensive.cpc - cheapest.cpc) / expensive.cpc) * 100)}% higher).`,
        action: 'Shift compatible agent workloads to the lower cost-per-call provider via gateway routing or connector config.',
        estimatedSavingsUsd: usd(monthlySavings),
        estimatedImpactUsd: usd(savings),
        mlScore,
        evidence: [
          `${expensive.provider} cpc=$${usd(expensive.cpc)}`,
          `${cheapest.provider} cpc=$${usd(cheapest.cpc)}`,
          `period_spend_${expensive.provider}=$${usd(expensive.costUsd)}`,
        ],
        relatedEntity: { type: 'provider', id: expensive.provider },
      });
    }
  }

  const spendValues = dailySpend.map((d) => d.costUsd);
  if (spendValues.length >= 7) {
    const z = zScoreLast(spendValues);
    const slope = linearTrendSlope(spendValues);
    if (z >= 2) {
      const mlScore = compositeMlScore([
        { weight: 0.6, value: Math.min(1, z / 4) },
        { weight: 0.4, value: slope > 0 ? Math.min(1, slope / 50) : 0 },
      ]);
      recs.push({
        id: 'spend-anomaly-spike',
        priority: priorityFromScore(mlScore),
        category: 'plan_optimization',
        title: 'Recent spend spike detected',
        message: `Daily spend z-score ${z.toFixed(1)} — usage is significantly above the prior baseline.`,
        action: 'Review model mix, rate limits, and agent run frequency; consider downgrading models for non-critical paths.',
        mlScore,
        evidence: [`z_score=${z.toFixed(2)}`, `trend_slope=${slope.toFixed(2)}/day`],
      });
    }
    if (slope > 5 && spendValues[spendValues.length - 1]! > 50) {
      recs.push({
        id: 'spend-trend-rising',
        priority: slope > 20 ? 'high' : 'medium',
        category: 'plan_optimization',
        title: 'Spend trend is rising',
        message: `Linear trend shows +$${usd(slope)}/day increase — project monthly run-rate before it compounds.`,
        action: 'Set budget alerts and evaluate prepaid vs pay-as-you-go plans at current trajectory.',
        mlScore: compositeMlScore([{ weight: 1, value: Math.min(1, slope / 30) }]),
        evidence: [`trend_slope=$${usd(slope)}/day`],
      });
    }
  }

  const lowEfficiency = rankings.filter((r) => r.costUsd > 50 && r.efficiencyScore < 25);
  for (const provider of lowEfficiency.slice(0, 2)) {
    const top = rankings[0];
    if (top && top.provider !== provider.provider) {
      recs.push({
        id: `low-value-provider-${provider.provider}`,
        priority: 'medium',
        category: 'provider_value',
        title: `${provider.provider} delivers low value per dollar`,
        message: `Efficiency score ${provider.efficiencyScore}/100 — $${usd(provider.costUsd)} spend with $${usd(provider.attributedValueUsd)} attributed value.`,
        action: `Prioritize ${top.provider} (efficiency ${top.efficiencyScore}/100) for new agent workloads; audit ${provider.provider} usage.`,
        estimatedImpactUsd: usd(provider.costUsd),
        mlScore: 100 - provider.efficiencyScore,
        evidence: [
          `efficiency_score=${provider.efficiencyScore}`,
          `value_per_dollar=${provider.valuePerDollar}`,
          `top_provider=${top.provider} (${top.efficiencyScore})`,
        ],
        relatedEntity: { type: 'provider', id: provider.provider },
      });
    }
  }

  return recs;
}

const AGENT_REC_PRIORITY: Partial<Record<Recommendation, RecommendationPriority>> = {
  pause: 'critical',
  retire: 'critical',
  investigate: 'high',
  require_approval: 'high',
  optimize: 'medium',
  improve_evidence: 'low',
  scale: 'low',
};

function agentEconomicsRecommendations(
  agents: AgentEconomicsHighlight[],
  periodDays: number,
): LariActionableRecommendation[] {
  const recs: LariActionableRecommendation[] = [];
  const actionable = agents.filter((a) =>
    ['pause', 'retire', 'investigate', 'require_approval', 'optimize', 'scale'].includes(a.recommendation),
  );

  for (const agent of actionable) {
    const priority = AGENT_REC_PRIORITY[agent.recommendation] ?? 'low';
    const savings =
      agent.recommendation === 'retire' || agent.recommendation === 'pause'
        ? agent.costUsd
        : agent.recommendation === 'optimize'
          ? agent.costUsd * 0.2
          : undefined;
    const mlScore = compositeMlScore([
      { weight: 0.4, value: priority === 'critical' ? 1 : priority === 'high' ? 0.7 : 0.4 },
      { weight: 0.3, value: Math.min(1, Math.abs(agent.lari)) },
      { weight: 0.3, value: agent.costUsd > 0 ? Math.min(1, agent.costUsd / 500) : 0 },
    ]);

    const titles: Record<string, string> = {
      scale: `Scale agent ${agent.agentId}`,
      optimize: `Optimize cost for agent ${agent.agentId}`,
      investigate: `Investigate agent ${agent.agentId}`,
      pause: `Pause agent ${agent.agentId}`,
      retire: `Retire agent ${agent.agentId}`,
      require_approval: `Gate agent ${agent.agentId} behind approval`,
      improve_evidence: `Improve evidence for agent ${agent.agentId}`,
    };

    recs.push({
      id: `agent-${agent.recommendation}-${agent.agentId}`,
      priority,
      category: 'agent_economics',
      title: titles[agent.recommendation] ?? `Review agent ${agent.agentId}`,
      message: `LARI ${agent.lari.toFixed(2)}× · $${usd(agent.valueUsd)} value · $${usd(agent.costUsd)} cost · confidence ${agent.confidenceScore}.`,
      action:
        agent.recommendation === 'scale'
          ? `Expand deployment — top provider: ${agent.topProvider ?? 'unknown'}.`
          : agent.recommendation === 'retire' || agent.recommendation === 'pause'
            ? 'Decommission or halt runs to stop ongoing spend with no return.'
            : agent.recommendation === 'optimize'
              ? `Review model selection and run frequency${agent.topProvider ? ` on ${agent.topProvider}` : ''}.`
              : 'Review agent runs, outcomes, and risk posture in the agent detail view.',
      estimatedSavingsUsd: savings !== undefined ? usd(savings * monthlyFactor(periodDays)) : undefined,
      estimatedImpactUsd: usd(agent.costUsd),
      mlScore,
      evidence: [
        `lari=${agent.lari}`,
        `recommendation=${agent.recommendation}`,
        `confidence=${agent.confidenceScore}`,
        ...(agent.topProvider ? [`top_provider=${agent.topProvider}`] : []),
      ],
      relatedEntity: { type: 'agent', id: agent.agentId },
    });
  }

  const topValue = [...agents].sort((a, b) => b.valueUsd - a.valueUsd)[0];
  if (topValue && topValue.valueUsd > 0 && topValue.recommendation === 'scale') {
    recs.push({
      id: `top-value-agent-${topValue.agentId}`,
      priority: 'low',
      category: 'agent_economics',
      title: `${topValue.agentId} delivers the most attributed value`,
      message: `$${usd(topValue.valueUsd)} attributed value at ${topValue.lari.toFixed(2)}× LARI — highest in portfolio.`,
      action: `Use ${topValue.agentId} as the benchmark; replicate patterns${topValue.topProvider ? ` on ${topValue.topProvider}` : ''}.`,
      mlScore: 30,
      evidence: [`value_usd=${usd(topValue.valueUsd)}`, `lari=${topValue.lari}`],
      relatedEntity: { type: 'agent', id: topValue.agentId },
    });
  }

  return recs;
}

function configurationRecommendations(input: LariRecommendationsInput): LariActionableRecommendation[] {
  const recs: LariActionableRecommendation[] = [];
  if (input.unmappedCostUsd > 50) {
    const mlScore = compositeMlScore([{ weight: 1, value: Math.min(1, input.unmappedCostUsd / 500) }]);
    recs.push({
      id: 'unmapped-spend',
      priority: priorityFromScore(mlScore),
      category: 'attribution',
      title: 'Unmapped user spend detected',
      message: `$${usd(input.unmappedCostUsd)} in the period lacks user attribution — allocation and per-agent economics are understated.`,
      action: 'Configure user attribution mappings on connectors or import seat assignments.',
      estimatedImpactUsd: usd(input.unmappedCostUsd),
      mlScore,
      evidence: [`unmapped_cost_usd=${usd(input.unmappedCostUsd)}`],
      relatedEntity: { type: 'user', id: 'Unassigned' },
    });
  }
  return recs;
}

const MIN_MODEL_SPEND_USD = 25;
const MIN_MONTHLY_SAVINGS_USD = 20;
const MIN_SAVINGS_SHARE = 0.1;
const MAX_MODEL_SUBSTITUTION_RECS = 3;

const EVAL_CAVEAT =
  'Run an offline eval of {candidate} on this workload before switching — quality regressions can erase cost savings.';

/** Model substitution — same-family cheaper alternatives via price book + actual token mix. */
export function modelSubstitutionRecs(
  input: Pick<LariRecommendationsInput, 'modelUsage' | 'priceBook' | 'periodDays'>,
): LariActionableRecommendation[] {
  const { modelUsage, priceBook, periodDays } = input;
  const factor = monthlyFactor(periodDays);
  const candidates: Array<{
    rec: LariActionableRecommendation;
    monthlySavings: number;
  }> = [];

  for (const row of modelUsage) {
    if (row.costUsd < MIN_MODEL_SPEND_USD) continue;

    const totalTokens = row.inputTokens + row.outputTokens;
    if (totalTokens <= 0) continue;

    const inputShare = row.inputTokens / totalTokens;
    const actualBlendedPerM = (row.costUsd / totalTokens) * 1_000_000;
    const monthlyRunRate = row.costUsd * factor;

    const alts = substitutionCandidates(
      { provider: row.provider, model: row.model },
      inputShare,
      priceBook,
    );
    if (alts.length === 0) continue;

    const best = alts[0]!;
    const projected = projectedCostUsd(best, row.inputTokens, row.outputTokens);
    const periodSavings = row.costUsd - projected;
    if (periodSavings <= 0) continue;

    const monthlySavings = periodSavings * factor;
    const savingsFloor = Math.max(MIN_MONTHLY_SAVINGS_USD, monthlyRunRate * MIN_SAVINGS_SHARE);
    if (monthlySavings < savingsFloor) continue;

    const incumbentRate = resolveModelRate(row.provider, row.model, priceBook);
    const incumbentListBlended = incumbentRate ? blendedRate(incumbentRate, inputShare) : 0;
    const candidateBlended = blendedRate(best, inputShare);
    const savingsPct = Math.round((periodSavings / row.costUsd) * 100);

    const mlScore = compositeMlScore([
      { weight: 0.5, value: Math.min(1, monthlySavings / 500) },
      { weight: 0.3, value: Math.min(1, savingsPct / 50) },
      { weight: 0.2, value: Math.min(1, row.costUsd / 1000) },
    ]);

    candidates.push({
      monthlySavings,
      rec: {
        id: `model-substitution-${row.provider}-${row.model}`,
        priority: priorityFromScore(mlScore),
        category: 'model_substitution',
        title: `Switch ${row.model} to ${best.model}`,
        message: `${row.provider}/${row.model} ran $${usd(row.costUsd)} in-range at $${usd(actualBlendedPerM)}/1M tokens (blended). ${best.model} lists $${usd(candidateBlended)}/1M vs $${usd(incumbentListBlended)}/1M at your ${Math.round(inputShare * 100)}% input share — est. ${savingsPct}% savings.`,
        action: EVAL_CAVEAT.replace('{candidate}', `${best.provider}/${best.model}`),
        estimatedSavingsUsd: usd(monthlySavings),
        estimatedImpactUsd: usd(periodSavings),
        mlScore,
        evidence: [
          `provider=${row.provider}, model=${row.model}`,
          `input_share=${Math.round(inputShare * 100)}%`,
          `actual_blended_per_m=$${usd(actualBlendedPerM)}`,
          `candidate=${best.provider}/${best.model}`,
          `candidate_blended_per_m=$${usd(candidateBlended)}`,
          `period_savings=$${usd(periodSavings)}`,
        ],
        relatedEntity: { type: 'model', id: `${row.provider}/${row.model}` },
      },
    });
  }

  return candidates
    .sort((a, b) => b.monthlySavings - a.monthlySavings)
    .slice(0, MAX_MODEL_SUBSTITUTION_RECS)
    .map((c) => c.rec);
}

const MAX_INDIVIDUAL_UNUSED_RECS = 5;

/** Platform usage — license optimization from seat assignments vs metered activity. */
export function userValueRecs(
  input: Pick<LariRecommendationsInput, 'userUtilization' | 'perUserMode' | 'periodDays'>,
): LariActionableRecommendation[] {
  const users = input.userUtilization ?? [];
  const mode = input.perUserMode ?? 'team';
  if (users.length === 0) return [];

  const recs: LariActionableRecommendation[] = [];
  const inactiveWithSeat = users.filter((u) => u.hasSeat && u.status === 'inactive');
  const lowUseWithSeat = users.filter((u) => u.hasSeat && u.status === 'low_use');

  if (mode === 'team') {
    const byPlan = new Map<
      string,
      { planId: string; planName: string; provider: string; count: number; savings: number }
    >();
    for (const u of inactiveWithSeat) {
      const key = u.planId ?? u.seatProvider ?? 'unknown';
      const entry = byPlan.get(key) ?? {
        planId: u.planId ?? key,
        planName: u.planName ?? 'Unassigned plan',
        provider: u.seatProvider ?? 'unknown',
        count: 0,
        savings: 0,
      };
      entry.count += 1;
      entry.savings += u.seatMonthlyCostUsd;
      byPlan.set(key, entry);
    }
    for (const group of byPlan.values()) {
      const mlScore = compositeMlScore([
        { weight: 0.5, value: Math.min(1, group.count / 10) },
        { weight: 0.5, value: Math.min(1, group.savings / 500) },
      ]);
      recs.push({
        id: `unused-platform-${group.planId}`,
        priority: priorityFromScore(mlScore),
        category: 'user_value',
        title: `Reclaim ${group.count} unused ${group.provider} seat${group.count === 1 ? '' : 's'}`,
        message: `${group.count} provisioned seat${group.count === 1 ? '' : 's'} on "${group.planName}" show no metered activity in-range — est. $${usd(group.savings)}/month in reclaimable license spend.`,
        action: 'Review seat assignments and deprovision unused licenses before renewal.',
        estimatedSavingsUsd: usd(group.savings),
        mlScore,
        evidence: [
          `plan=${group.planName}`,
          `provider=${group.provider}`,
          `inactive_seats=${group.count}`,
          UTILIZATION_CAVEAT,
        ],
        relatedEntity: { type: 'plan', id: group.planId },
      });
    }
    const lowByPlan = new Map<
      string,
      { planId: string; planName: string; provider: string; count: number; savings: number }
    >();
    for (const u of lowUseWithSeat) {
      const key = u.planId ?? u.seatProvider ?? 'unknown';
      const entry = lowByPlan.get(key) ?? {
        planId: u.planId ?? key,
        planName: u.planName ?? 'Unassigned plan',
        provider: u.seatProvider ?? 'unknown',
        count: 0,
        savings: 0,
      };
      entry.count += 1;
      entry.savings += u.seatMonthlyCostUsd * 0.5;
      lowByPlan.set(key, entry);
    }
    for (const group of lowByPlan.values()) {
      const mlScore = compositeMlScore([
        { weight: 0.4, value: Math.min(1, group.count / 10) },
        { weight: 0.6, value: Math.min(1, group.savings / 300) },
      ]);
      recs.push({
        id: `low-use-platform-${group.planId}`,
        priority: priorityFromScore(mlScore * 0.85),
        category: 'user_value',
        title: `Review ${group.count} low-use ${group.provider} seat${group.count === 1 ? '' : 's'}`,
        message: `${group.count} seat${group.count === 1 ? '' : 's'} on "${group.planName}" show minimal metered activity — est. $${usd(group.savings)}/month recoverable via downgrade or reassignment.`,
        action: 'Confirm with team owners whether licenses can be downgraded or reassigned.',
        estimatedSavingsUsd: usd(group.savings),
        mlScore,
        evidence: [
          `plan=${group.planName}`,
          `provider=${group.provider}`,
          `low_use_seats=${group.count}`,
          `savings_assumption=50% of seat cost`,
          UTILIZATION_CAVEAT,
        ],
        relatedEntity: { type: 'plan', id: group.planId },
      });
    }
    return recs;
  }

  const sortedInactive = [...inactiveWithSeat].sort(
    (a, b) => b.seatMonthlyCostUsd - a.seatMonthlyCostUsd,
  );
  for (const u of sortedInactive.slice(0, MAX_INDIVIDUAL_UNUSED_RECS)) {
    const mlScore = compositeMlScore([
      { weight: 0.6, value: Math.min(1, u.seatMonthlyCostUsd / 100) },
      { weight: 0.4, value: 1 },
    ]);
    recs.push({
      id: `unused-platform-user-${u.userId}`,
      priority: priorityFromScore(mlScore),
      category: 'user_value',
      title: `Unused platform access — ${u.displayName}`,
      message: `Provisioned ${u.seatProvider ?? 'platform'} seat ($${usd(u.seatMonthlyCostUsd)}/mo) with no metered activity in-range.`,
      action: 'Reassign or deprovision the license if platform access is no longer needed.',
      estimatedSavingsUsd: usd(u.seatMonthlyCostUsd),
      mlScore,
      evidence: [
        `user=${u.displayName}`,
        `seat_provider=${u.seatProvider ?? 'unknown'}`,
        `seat_monthly=$${usd(u.seatMonthlyCostUsd)}`,
        UTILIZATION_CAVEAT,
      ],
      relatedEntity: { type: 'user', id: u.userId },
    });
  }

  for (const u of users) {
    if (!u.dailyCost || u.dailyCost.length < 7) continue;
    const z = zScoreLast(u.dailyCost);
    const callSlope = u.dailyCalls ? linearTrendSlope(u.dailyCalls) : 0;
    if (z <= 3 || callSlope > 0) continue;

    const mlScore = compositeMlScore([
      { weight: 0.6, value: Math.min(1, z / 5) },
      { weight: 0.4, value: callSlope <= 0 ? 1 : 0 },
    ]);
    recs.push({
      id: `cost-without-activity-${u.userId}`,
      priority: priorityFromScore(mlScore),
      category: 'user_value',
      title: `Cost spike without usage growth — ${u.displayName}`,
      message: `Daily spend z-score ${z.toFixed(1)} while call volume is flat or declining — review license allocation vs metered usage.`,
      action: 'Audit recent imports and seat assignments; confirm spend is attributed to active platform use.',
      estimatedImpactUsd: usd(u.costUsd),
      mlScore,
      evidence: [
        `user=${u.displayName}`,
        `z_score=${z.toFixed(2)}`,
        `call_trend_slope=${callSlope.toFixed(2)}`,
        UTILIZATION_CAVEAT,
      ],
      relatedEntity: { type: 'user', id: u.userId },
    });
  }

  return recs;
}

/** Orchestrator — pure, deterministic, auditable. */
export function generateLariRecommendations(input: LariRecommendationsInput): {
  recommendations: LariActionableRecommendation[];
  providerRankings: ProviderValueRanking[];
} {
  const providerRankings = rankProviders(
    input.providerSpend,
    input.agentProviderSpend,
    input.agentEconomics,
  );

  const all = [
    ...seatRecommendations(input),
    ...planRecommendations(input, providerRankings),
    ...agentEconomicsRecommendations(input.agentEconomics, input.periodDays),
    ...configurationRecommendations(input),
    ...modelSubstitutionRecs(input),
    ...userValueRecs(input),
  ];

  const recommendations = all.sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return p !== 0 ? p : b.mlScore - a.mlScore;
  });

  return { recommendations, providerRankings };
}

import { BadRequestException, Injectable } from '@nestjs/common';

import { ChParam } from '../clickhouse/clickhouse.service';

import { AnalyticsStore } from '../analytics-store/analytics-store';

import { CopilotAnalyticsService, COPILOT_ANALYTICS_PLATFORM } from '../github-copilot/github-copilot-analytics.service';
import { CursorAnalyticsService } from '../connectors/cursor-analytics.service';
import { CursorProductivityService } from '../connectors/cursor-productivity.service';
import {
  RECONCILED_COST_BASIS_MONTHLY_SQL,
  RECONCILED_COST_BASIS_TOTALS_SQL,
  RECONCILED_MODEL_USAGE_SQL,
  RECONCILED_PROVIDER_SPEND_SQL,
  RECONCILED_UNMAPPED_SPEND_SQL,
} from '../connectors/metered-cost';

import { PrismaService } from '../prisma/prisma.service';

import { getTenantId } from '../tenant/tenant-context';
import { sumProratedMonthlyCosts } from '../fixed-costs/fixed-cost-prorate';

import {

  CostBasisMode,

  CostProvenance,

  CfoViewMonthly,

  CfoViewOutcomeBreakdown,

  CfoViewModelBreakdown,

  CfoViewProviderBreakdown,

  CfoViewResponse,

  CfoViewSummary,

} from './lari-cfo-view.types';



type Range = { from: string; to: string };



const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

const pct = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;



interface RoiAggRow {

  month: string;

  outcome_type: string;

  outcomes: number;

  value_usd: number;

  ai_cost_usd: number;

  fully_loaded_cost_usd: number;

  nominal_roi_usd: number;

  risk_adjusted_roi_usd: number;

  avg_confidence: number;

}



interface CostBasisTotals {

  computed_cost_usd: number;

  metered_cost_usd: number;

  effective_cost_usd: number;

  calls: number;

  total_keys: number;

  metered_keys: number;

}



interface CostBasisMonthlyRow {

  month: string;

  computed_cost_usd: number;

  metered_cost_usd: number;

  effective_cost_usd: number;

}



/**

 * Tenant-level CFO view — aggregates the existing v_roi engine (no duplicate ROI

 * math) plus supplemental subscription and coding-agent costs from Postgres/CH.

 * Confidence threshold filters outcome links before aggregation (Phase 4 bar).

 */

@Injectable()

export class LariCfoViewService {

  constructor(

    private readonly ch: AnalyticsStore,

    private readonly prisma: PrismaService,

    private readonly copilotAnalytics: CopilotAnalyticsService,

    private readonly cursorAnalytics: CursorAnalyticsService,

    private readonly cursorProductivity: CursorProductivityService,

  ) {}



  async getCfoView(

    from?: string,

    to?: string,

    confidenceThreshold = 0.5,

    team?: string,

    costBasis: CostBasisMode = 'reconciled',

    forecastDays = 365,

  ): Promise<CfoViewResponse> {

    const tenantId = getTenantId();

    if (!tenantId) {

      throw new BadRequestException('no tenant in context');

    }

    const basis = this.normalizeCostBasis(costBasis);

    const r = this.range(from, to, 365);

    const minconf = Math.max(0, Math.min(1, confidenceThreshold));

    const params: Record<string, ChParam> = { ...r, minconf };

    const tf = team ? ((params.team = team), 'AND team_id = {team:String}') : '';



    const roiRows = await this.ch.queryScoped<RoiAggRow>(

      `SELECT toStartOfMonth(outcome_ts) AS month, outcome_type AS outcome_type,

              count() AS outcomes,

              sum(value_usd) AS value_usd,

              sum(ai_cost_usd) AS ai_cost_usd,

              sum(fully_loaded_cost_usd) AS fully_loaded_cost_usd,

              sum(nominal_roi_usd) AS nominal_roi_usd,

              sum(risk_adjusted_roi_usd) AS risk_adjusted_roi_usd,

              avg(attribution_confidence) AS avg_confidence

       FROM agentledger.v_roi

       WHERE tenant_id = {tenant:String}

         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}

         AND attribution_confidence >= {minconf:Float32} ${tf}

       GROUP BY month, outcome_type ORDER BY month`,

      params,

    );

    const providerRows =
      basis === 'reconciled'
        ? await this.ch.queryScoped<{ provider: string; cost_usd: number; calls: number }>(
            RECONCILED_PROVIDER_SPEND_SQL,
            params,
          )
        : await this.ch.queryScoped<{ provider: string; cost_usd: number; calls: number }>(
            `SELECT provider, sum(cost_usd) AS cost_usd, sum(calls) AS calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY provider ORDER BY cost_usd DESC`,
            params,
          );
    const costBasisTotals = await this.queryCostBasisTotals(params, basis);
    const costBasisMonthly = await this.queryCostBasisMonthly(params, basis);
    const modelUsageRows =
      basis === 'reconciled'
        ? await this.ch.queryScoped<{
            provider: string;
            model: string;
            input_tokens: number;
            output_tokens: number;
            calls: number;
            cost_usd: number;
          }>(RECONCILED_MODEL_USAGE_SQL, params).then((rows) =>
            rows.map((row) => ({
              provider: String(row.provider),
              model: String(row.model),
              input_tokens: n(row.input_tokens),
              output_tokens: n(row.output_tokens),
              calls: n(row.calls),
              computed_cost_usd: n(row.cost_usd),
            })),
          )
        : await this.ch.queryScoped<{
            provider: string;
            model: string;
            input_tokens: number;
            output_tokens: number;
            calls: number;
            computed_cost_usd: number;
          }>(
            `SELECT provider, model,
                sum(input_tokens) AS input_tokens,
                sum(output_tokens) AS output_tokens,
                sum(calls) AS calls,
                sum(cost_usd) AS computed_cost_usd
         FROM spend_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY provider, model
         ORDER BY computed_cost_usd DESC`,
            params,
          );
    const modelBasisRows =
      basis === 'reconciled'
        ? modelUsageRows.map((row) => ({
            provider: row.provider,
            model: row.model,
            computed_cost_usd: row.computed_cost_usd,
            metered_cost_usd: row.computed_cost_usd,
            effective_cost_usd: row.computed_cost_usd,
          }))
        : await this.queryModelCostBasis(params);

    const codingAgentCost = await this.ch.queryScoped<{ cost_usd: number }>(

      `SELECT sum(cost_usd) AS cost_usd

       FROM agentledger.coding_agent_daily

       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,

      params,

    );

    const unmappedSpend = await this.ch.queryScoped<{ unmapped_cost: number }>(
      basis === 'reconciled'
        ? RECONCILED_UNMAPPED_SPEND_SQL
        : `SELECT sum(cost_usd) AS unmapped_cost
       FROM spend_daily_by_user
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         AND user_id = 'Unassigned'`,
      params,
    );

    const [subscriptionCost, fixedCostObserved, seatStats, copilotSpend, cursorSpendSummary, cursorProductivity] =
      await Promise.all([

      this.subscriptionCostForPeriod(tenantId, r),

      this.fixedCostForPeriod(r),

      this.seatStats(tenantId),

      this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to),

      this.cursorAnalytics.getSpendSummary(tenantId, r.from, r.to),

      this.cursorProductivity.getProductivitySummary(tenantId, r.from, r.to),

    ]);

    const fixedCostBase = fixedCostObserved > 0 ? fixedCostObserved : subscriptionCost;



    const totals = costBasisTotals[0] ?? {

      computed_cost_usd: 0,

      metered_cost_usd: 0,

      effective_cost_usd: 0,

      calls: 0,

      total_keys: 0,

      metered_keys: 0,

    };

    const costProvenanceBase = this.buildCostProvenance(totals);

    const usageCost = this.usageCostForBasis(basis, totals);



    const copilotCost = copilotSpend?.totalCostUsd ?? 0;

    const copilotValue = copilotSpend?.estimatedValueUsd ?? 0;
    const cursorProductivityValue = cursorProductivity?.estimatedValueUsd ?? 0;
    const cursorSpendUsd =
      (cursorSpendSummary?.meteredOverageUsd ?? 0) + (cursorSpendSummary?.seatLicenseUsd ?? 0);

    const supplementalCost = n(codingAgentCost[0]?.cost_usd) + fixedCostBase + copilotCost;

    const outcomeCount = roiRows.reduce((s, row) => s + n(row.outcomes), 0);

    const totalOutcomesAll = await this.outcomeCountAll(tenantId, r, tf, params);



    const businessValue =
      roiRows.reduce((s, row) => s + n(row.value_usd), 0) + copilotValue + cursorProductivityValue;

    const outcomeFullyLoaded = roiRows.reduce((s, row) => s + n(row.fully_loaded_cost_usd), 0);

    const outcomeAiCost = roiRows.reduce((s, row) => s + n(row.ai_cost_usd), 0);

    const outcomeRiskAdjustedValue = roiRows.reduce(

      (s, row) => s + n(row.risk_adjusted_roi_usd) + n(row.fully_loaded_cost_usd),

      0,

    );

    // Copilot estimated value already applies qualityAdjustmentFactor (default 0.5) — treat as
    // risk-adjusted productivity value with no additional risk_exposure discount.
    const riskAdjustedValue = outcomeRiskAdjustedValue + copilotValue + cursorProductivityValue;



    // Token/API usage from v_cost_basis_daily; v_roi only covers AI cost on outcome-linked runs.

    // Add QA/eval/integration/platform from outcomes without double-counting token spend.

    const qaEvalOverhead = Math.max(0, outcomeFullyLoaded - outcomeAiCost);

    const observedFullyLoadedCost = usageCost + supplementalCost + qaEvalOverhead;

    const periodDays = Math.max(
      1,
      (new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000 + 1,
    );
    const horizonDays = Math.max(1, forecastDays);
    const variableScale = horizonDays / periodDays;
    const monthsInWindow = Math.max(periodDays / 30.437, 1 / 30.437);
    const monthlyFixed = fixedCostBase / monthsInWindow;
    const forecastFixed = monthlyFixed * (horizonDays / 30.437);

    const forecastToken = usageCost * variableScale;
    const forecastCoding = n(codingAgentCost[0]?.cost_usd) * variableScale;
    const forecastCopilot = copilotCost * variableScale;
    const forecastOverhead = qaEvalOverhead * variableScale;

    const fullyLoadedCost =
      forecastToken + forecastFixed + forecastCoding + forecastCopilot + forecastOverhead;

    // Headline ROI uses observed window — projected spend is shown separately on the forecast card.
    const observedNominalRoi = businessValue - observedFullyLoadedCost;
    const observedRiskAdjustedRoi = riskAdjustedValue - observedFullyLoadedCost;

    const effectiveOutcomeCount =
      outcomeCount + (cursorProductivity?.activeUserDays ?? 0);
    const costPerOutcome =
      effectiveOutcomeCount > 0 ? usd(observedFullyLoadedCost / effectiveOutcomeCount) : null;
    const cpoFallback =
      effectiveOutcomeCount === 0
        ? this.computeCostPerOutcomeFallback(
            observedFullyLoadedCost,
            n(totals.calls),
            modelUsageRows.reduce((s, row) => s + n(row.input_tokens) + n(row.output_tokens), 0),
            copilotSpend?.totalCalls ?? 0,
          )
        : {
            costPerOutcomeFallback: null,
            costPerOutcomeFallbackLabel: null,
            costPerOutcomeFallbackBasis: null,
          };

    const costProvenance: CostProvenance = {
      ...costProvenanceBase,
      stack: {
        tokenUsageUsd: usd(forecastToken),
        tokenComputedUsd: usd(n(totals.computed_cost_usd) * variableScale),
        tokenMeteredUsd: usd(n(totals.metered_cost_usd) * variableScale),
        fixedCostUsd: usd(forecastFixed),
        codingAgentUsd: usd(forecastCoding),
        copilotUsd: usd(forecastCopilot),
        qaEvalOverheadUsd: usd(forecastOverhead),
      },
    };



    const monthly = this.buildMonthly(roiRows, costBasisMonthly, supplementalCost, basis);

    const runRateMonths = monthly.length;

    const forecastPerMonth = runRateMonths > 0 ? observedRiskAdjustedRoi / runRateMonths : 0;

    const roiMargin =
      observedFullyLoadedCost > 0 ? observedRiskAdjustedRoi / observedFullyLoadedCost : 0;



    const summary: CfoViewSummary = {

      riskAdjustedRoi: usd(observedRiskAdjustedRoi),

      nominalRoi: usd(observedNominalRoi),

      businessValue: usd(businessValue),

      fullyLoadedCost: usd(fullyLoadedCost),

      observedFullyLoadedCost: usd(observedFullyLoadedCost),

      forecastPerMonth: usd(forecastPerMonth),

      roiMargin: Math.round(roiMargin * 10_000) / 10_000,

      runRateMonths,

      costPerOutcome,

      costPerOutcomeFallback: cpoFallback.costPerOutcomeFallback,

      costPerOutcomeFallbackLabel: cpoFallback.costPerOutcomeFallbackLabel,

      costPerOutcomeFallbackBasis: cpoFallback.costPerOutcomeFallbackBasis,

      costBasis: basis,

      forecastDays: horizonDays,

      observedPeriodDays: periodDays,

    };



    const outcomeBreakdown = this.buildOutcomeBreakdown(roiRows, {
      usageCost,
      supplementalCost: fixedCostBase + n(codingAgentCost[0]?.cost_usd) + copilotCost,
      outcomeAiCost,
      outcomeCount,
    });
    if (cursorProductivity && cursorProductivity.estimatedValueUsd > 0) {
      outcomeBreakdown.push(
        this.cursorProductivity.toOutcomeBreakdownRow(cursorProductivity, cursorSpendUsd),
      );
      outcomeBreakdown.sort((a, b) => b.riskAdjustedRoi - a.riskAdjustedRoi);
    }

    const modelBreakdown = this.buildModelBreakdown(
      modelUsageRows,
      modelBasisRows,
      basis,
      variableScale,
    );

    const providerBreakdown: CfoViewProviderBreakdown[] = providerRows.map((row) => ({

      provider: String(row.provider),

      costUsd: usd(n(row.cost_usd)),

      calls: n(row.calls),

    }));

    if (copilotCost > 0) {

      providerBreakdown.push({

        provider: COPILOT_ANALYTICS_PLATFORM,

        costUsd: usd(copilotCost),

        calls: copilotSpend?.totalCalls ?? 0,

      });

      providerBreakdown.sort((a, b) => b.costUsd - a.costUsd);

    }



    const warnings = this.buildWarnings({

      fullyLoadedCost,

      usageCost,

      businessValue,

      outcomeCount,

      totalOutcomesAll,

      minconf,

      unmappedCost: n(unmappedSpend[0]?.unmapped_cost),

      seatStats,

      supplementalCost,

      copilotValue,

      cursorProductivityValue,

      costBasis: basis,

      costProvenance,

    });



    return {

      from: r.from,

      to: r.to,

      confidenceThreshold: minconf,

      summary,

      monthly,

      outcomeBreakdown,

      modelBreakdown,

      providerBreakdown,

      costProvenance,

      warnings,

    };

  }




  private async queryModelCostBasis(
    params: Record<string, ChParam>,
  ): Promise<
    Array<{
      provider: string;
      model: string;
      computed_cost_usd: number;
      metered_cost_usd: number;
      effective_cost_usd: number;
    }>
  > {
    try {
      return await this.ch.queryScoped(
        `SELECT provider, model,
                sum(computed_cost_usd) AS computed_cost_usd,
                sum(metered_cost_usd) AS metered_cost_usd,
                sum(effective_cost_usd) AS effective_cost_usd
         FROM agentledger.v_cost_basis_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY provider, model`,
        params,
      );
    } catch {
      return [];
    }
  }

  private buildModelBreakdown(
    usageRows: Array<{
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      calls: number;
      computed_cost_usd: number;
    }>,
    basisRows: Array<{
      provider: string;
      model: string;
      computed_cost_usd: number;
      metered_cost_usd: number;
      effective_cost_usd: number;
    }>,
    basis: CostBasisMode,
    variableScale: number,
  ): CfoViewModelBreakdown[] {
    const basisByKey = new Map(
      basisRows.map((r) => [
        `${String(r.provider)}::${String(r.model)}`,
        {
          computed: n(r.computed_cost_usd),
          metered: n(r.metered_cost_usd),
          effective: n(r.effective_cost_usd),
        },
      ]),
    );

    return usageRows
      .map((row) => {
        const key = `${String(row.provider)}::${String(row.model)}`;
        const b = basisByKey.get(key);
        const computed = b?.computed ?? n(row.computed_cost_usd);
        const observedCost =
          basis === 'computed' ? computed : basis === 'metered' ? (b?.metered ?? 0) : (b?.effective ?? computed);
        const inputTokens = n(row.input_tokens);
        const outputTokens = n(row.output_tokens);
        const totalTokens = inputTokens + outputTokens;
        const costPerToken = totalTokens > 0 ? observedCost / totalTokens : 0;
        const costPer1M = costPerToken * 1_000_000;
        const projectedCost = observedCost * variableScale;

        return {
          provider: String(row.provider),
          model: String(row.model),
          costUsd: usd(projectedCost),
          observedCostUsd: usd(observedCost),
          inputTokens,
          outputTokens,
          totalTokens,
          costPer1MTokens: usd(costPer1M),
          costPerToken: Math.round(costPerToken * 1e8) / 1e8,
          calls: n(row.calls),
        };
      })
      .filter((r) => r.observedCostUsd > 0 || r.totalTokens > 0)
      .sort((a, b) => b.observedCostUsd - a.observedCostUsd);
  }

  private async queryCostBasisTotals(
    params: Record<string, ChParam>,
    basis: CostBasisMode,
  ): Promise<CostBasisTotals[]> {
    if (basis === 'reconciled') {
      return this.ch.queryScoped<CostBasisTotals>(RECONCILED_COST_BASIS_TOTALS_SQL, params);
    }
    try {
      return await this.ch.queryScoped<CostBasisTotals>(
        `SELECT sum(computed_cost_usd) AS computed_cost_usd,
                sum(metered_cost_usd) AS metered_cost_usd,
                sum(effective_cost_usd) AS effective_cost_usd,
                sum(calls) AS calls,
                count() AS total_keys,
                countIf(metered_cost_usd > 0) AS metered_keys
         FROM agentledger.v_cost_basis_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
        params,
      );
    } catch {
      return this.ch.queryScoped<CostBasisTotals>(
        `SELECT sum(cost_usd) AS computed_cost_usd,
                0 AS metered_cost_usd,
                sum(cost_usd) AS effective_cost_usd,
                sum(calls) AS calls,
                count() AS total_keys,
                0 AS metered_keys
         FROM spend_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
        params,
      );
    }
  }

  private async queryCostBasisMonthly(
    params: Record<string, ChParam>,
    basis: CostBasisMode,
  ): Promise<CostBasisMonthlyRow[]> {
    if (basis === 'reconciled') {
      return this.ch.queryScoped<CostBasisMonthlyRow>(RECONCILED_COST_BASIS_MONTHLY_SQL, params);
    }
    try {
      return await this.ch.queryScoped<CostBasisMonthlyRow>(
        `SELECT toStartOfMonth(day) AS month,
                sum(computed_cost_usd) AS computed_cost_usd,
                sum(metered_cost_usd) AS metered_cost_usd,
                sum(effective_cost_usd) AS effective_cost_usd
         FROM agentledger.v_cost_basis_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY month ORDER BY month`,
        params,
      );
    } catch {
      return this.ch.queryScoped<CostBasisMonthlyRow>(
        `SELECT toStartOfMonth(day) AS month,
                sum(cost_usd) AS computed_cost_usd,
                0 AS metered_cost_usd,
                sum(cost_usd) AS effective_cost_usd
         FROM spend_daily
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY month ORDER BY month`,
        params,
      );
    }
  }

  private computeCostPerOutcomeFallback(
    fullyLoadedCost: number,
    apiCalls: number,
    totalTokens: number,
    copilotCalls: number,
  ): {
    costPerOutcomeFallback: number | null;
    costPerOutcomeFallbackLabel: string | null;
    costPerOutcomeFallbackBasis: string | null;
  } {
    if (fullyLoadedCost <= 0) {
      return {
        costPerOutcomeFallback: null,
        costPerOutcomeFallbackLabel: null,
        costPerOutcomeFallbackBasis: null,
      };
    }
    if (apiCalls > 0) {
      return {
        costPerOutcomeFallback: usd(fullyLoadedCost / apiCalls),
        costPerOutcomeFallbackLabel: 'per model call',
        costPerOutcomeFallbackBasis: `${apiCalls.toLocaleString('en-US')} API/model calls — proxy until outcomes are linked`,
      };
    }
    if (totalTokens > 0) {
      const tokenMillions = totalTokens / 1_000_000;
      return {
        costPerOutcomeFallback: usd(fullyLoadedCost / tokenMillions),
        costPerOutcomeFallbackLabel: 'per 1M tokens',
        costPerOutcomeFallbackBasis: `${tokenMillions.toFixed(2)}M tokens processed — proxy until outcomes are linked`,
      };
    }
    if (copilotCalls > 0) {
      return {
        costPerOutcomeFallback: usd(fullyLoadedCost / copilotCalls),
        costPerOutcomeFallbackLabel: 'per Copilot interaction',
        costPerOutcomeFallbackBasis: `${copilotCalls.toLocaleString('en-US')} Copilot acceptances, chat turns, and PR summaries — proxy until outcomes are linked`,
      };
    }
    return {
      costPerOutcomeFallback: null,
      costPerOutcomeFallbackLabel: null,
      costPerOutcomeFallbackBasis: null,
    };
  }

  private normalizeCostBasis(costBasis?: string): CostBasisMode {

    if (costBasis === 'computed' || costBasis === 'metered' || costBasis === 'reconciled') {

      return costBasis;

    }

    return 'reconciled';

  }



  private usageCostForBasis(basis: CostBasisMode, totals: CostBasisTotals): number {

    if (basis === 'computed') return n(totals.computed_cost_usd);

    if (basis === 'metered') return n(totals.metered_cost_usd);

    return n(totals.effective_cost_usd);

  }



  private monthlyUsageForBasis(basis: CostBasisMode, row: CostBasisMonthlyRow): number {

    if (basis === 'computed') return n(row.computed_cost_usd);

    if (basis === 'metered') return n(row.metered_cost_usd);

    return n(row.effective_cost_usd);

  }



  private buildCostProvenance(totals: CostBasisTotals): CostProvenance {

    const computed = n(totals.computed_cost_usd);

    const metered = n(totals.metered_cost_usd);

    const effective = n(totals.effective_cost_usd);

    const totalKeys = n(totals.total_keys);

    const meteredKeys = n(totals.metered_keys);

    const variancePct = computed > 0 ? ((metered - computed) / computed) * 100 : 0;

    const meteredCoveragePct = totalKeys > 0 ? (meteredKeys / totalKeys) * 100 : 0;

    return {

      computedCostUsd: usd(computed),

      meteredCostUsd: usd(metered),

      effectiveCostUsd: usd(effective),

      variancePct: pct(variancePct),

      meteredCoveragePct: pct(meteredCoveragePct),

      stack: {
        tokenUsageUsd: 0,
        tokenComputedUsd: usd(computed),
        tokenMeteredUsd: usd(metered),
        fixedCostUsd: 0,
        codingAgentUsd: 0,
        copilotUsd: 0,
        qaEvalOverheadUsd: 0,
      },

    };

  }



  private range(from: string | undefined, to: string | undefined, days = 365): Range {

    const today = new Date();

    const start = new Date(today);

    start.setUTCDate(start.getUTCDate() - days);

    const iso = (d: Date) => d.toISOString().slice(0, 10);

    return { from: from ?? iso(start), to: to ?? iso(today) };

  }



  private buildMonthly(

    rows: RoiAggRow[],

    costBasisMonthly: CostBasisMonthlyRow[],

    supplementalCost: number,

    basis: CostBasisMode,

  ): CfoViewMonthly[] {

    const byMonth = new Map<string, RoiAggRow>();

    for (const row of rows) {

      const m = String(row.month).slice(0, 7);

      const prev = byMonth.get(m);

      if (prev) {

        prev.outcomes = n(prev.outcomes) + n(row.outcomes);

        prev.value_usd = n(prev.value_usd) + n(row.value_usd);

        prev.ai_cost_usd = n(prev.ai_cost_usd) + n(row.ai_cost_usd);

        prev.fully_loaded_cost_usd = n(prev.fully_loaded_cost_usd) + n(row.fully_loaded_cost_usd);

        prev.nominal_roi_usd = n(prev.nominal_roi_usd) + n(row.nominal_roi_usd);

        prev.risk_adjusted_roi_usd = n(prev.risk_adjusted_roi_usd) + n(row.risk_adjusted_roi_usd);

      } else {

        byMonth.set(m, { ...row, month: m });

      }

    }

    for (const spend of costBasisMonthly) {

      const m = String(spend.month).slice(0, 7);

      if (!byMonth.has(m)) {

        byMonth.set(m, {

          month: m,

          outcome_type: '',

          outcomes: 0,

          value_usd: 0,

          ai_cost_usd: 0,

          fully_loaded_cost_usd: 0,

          nominal_roi_usd: 0,

          risk_adjusted_roi_usd: 0,

          avg_confidence: 0,

        });

      }

    }

    const months = [...byMonth.keys()].sort();

    const perMonthSupplement = months.length > 0 ? supplementalCost / months.length : 0;

    return months.map((month) => {

      const row = byMonth.get(month)!;

      const spendRow = costBasisMonthly.find((s) => String(s.month).slice(0, 7) === month);

      const monthUsage = spendRow ? this.monthlyUsageForBasis(basis, spendRow) : 0;

      const monthOutcomeLoaded = n(row.fully_loaded_cost_usd);

      const monthOutcomeAi = n(row.ai_cost_usd);

      const monthNonToken = Math.max(0, monthOutcomeLoaded - monthOutcomeAi);

      const monthFullyLoaded = monthUsage + perMonthSupplement + monthNonToken;

      const monthRiskAdjValue = n(row.risk_adjusted_roi_usd) + monthOutcomeLoaded;

      return {

        month,

        businessValue: usd(n(row.value_usd)),

        fullyLoadedCost: usd(monthFullyLoaded),

        nominalRoi: usd(n(row.value_usd) - monthFullyLoaded),

        riskAdjustedRoi: usd(monthRiskAdjValue - monthFullyLoaded),

      };

    });

  }



  private buildOutcomeBreakdown(
    rows: RoiAggRow[],
    ctx: {
      usageCost: number;
      supplementalCost: number;
      outcomeAiCost: number;
      outcomeCount: number;
    },
  ): CfoViewOutcomeBreakdown[] {

    const byType = new Map<string, RoiAggRow>();

    for (const row of rows) {

      const t = String(row.outcome_type);

      const prev = byType.get(t);

      if (prev) {

        prev.outcomes = n(prev.outcomes) + n(row.outcomes);

        prev.value_usd = n(prev.value_usd) + n(row.value_usd);

        prev.ai_cost_usd = n(prev.ai_cost_usd) + n(row.ai_cost_usd);

        prev.fully_loaded_cost_usd = n(prev.fully_loaded_cost_usd) + n(row.fully_loaded_cost_usd);

        prev.nominal_roi_usd = n(prev.nominal_roi_usd) + n(row.nominal_roi_usd);

        prev.risk_adjusted_roi_usd = n(prev.risk_adjusted_roi_usd) + n(row.risk_adjusted_roi_usd);

        prev.avg_confidence = (n(prev.avg_confidence) + n(row.avg_confidence)) / 2;

      } else {

        byType.set(t, { ...row });

      }

    }

    const sharedPool = ctx.usageCost + ctx.supplementalCost;

    return [...byType.entries()]

      .map(([outcomeType, row]) => {

        const outcomes = n(row.outcomes);

        const typeAi = n(row.ai_cost_usd);

        const typeLoaded = n(row.fully_loaded_cost_usd);

        const weight =
          ctx.outcomeAiCost > 0
            ? typeAi / ctx.outcomeAiCost
            : ctx.outcomeCount > 0
              ? outcomes / ctx.outcomeCount
              : 0;

        const allocatedShared = sharedPool * weight;

        const typeOverhead = Math.max(0, typeLoaded - typeAi);

        const fullyLoaded = allocatedShared + typeOverhead;

        return {

          outcomeType,

          outcomes,

          businessValue: usd(n(row.value_usd)),

          fullyLoadedCost: usd(fullyLoaded),

          nominalRoi: usd(n(row.nominal_roi_usd)),

          riskAdjustedRoi: usd(n(row.risk_adjusted_roi_usd)),

          avgConfidence: Math.round(n(row.avg_confidence) * 100) / 100,

          costPerOutcome: usd(outcomes > 0 ? fullyLoaded / outcomes : 0),

        };

      })

      .sort((a, b) => b.riskAdjustedRoi - a.riskAdjustedRoi);

  }



  /** Seat licenses and recurring overhead from fixed_costs, prorated to the query window. */
  private async fixedCostForPeriod(r: Range): Promise<number> {
    const rows = await this.ch.queryScoped<{ period_month: string; cost_usd: number }>(
      `SELECT period_month, cost_usd
       FROM agentledger.fixed_costs FINAL
       WHERE tenant_id = {tenant:String}
         AND period_month >= toStartOfMonth(toDate({from:String}))
         AND period_month <= toStartOfMonth(toDate({to:String}))
         AND attributable = 0`,
      { from: r.from, to: r.to },
    );
    return sumProratedMonthlyCosts(
      rows.map((row) => ({ period_month: String(row.period_month), cost_usd: n(row.cost_usd) })),
      r.from,
      r.to,
    );
  }

  /** Prorate subscription contract cost across the query window (fallback when fixed_costs empty). */

  private async subscriptionCostForPeriod(tenantId: string, r: Range): Promise<number> {

    const plans = await this.prisma.withTenant(tenantId, (tx) =>

      tx.$queryRaw<{ contract_monthly_cost: number | string }[]>`

        SELECT contract_monthly_cost FROM ai_subscription_plans WHERE contract_monthly_cost > 0`,

    );

    if (plans.length === 0) return 0;



    const fromMs = new Date(r.from).getTime();

    const toMs = new Date(r.to).getTime();

    const windowDays = Math.max(1, (toMs - fromMs) / 86_400_000 + 1);

    const monthsInWindow = windowDays / 30;

    const monthlyTotal = plans.reduce((s, p) => s + n(p.contract_monthly_cost), 0);

    return monthlyTotal * monthsInWindow;

  }



  private async seatStats(tenantId: string): Promise<{ purchased: number; active: number }> {

    const rows = await this.prisma.withTenant(tenantId, (tx) =>

      tx.$queryRaw<{ purchased: number; active: number }[]>`

        SELECT

          COALESCE(SUM(p.seats_purchased), 0)::int AS purchased,

          COALESCE(SUM(CASE WHEN s.active THEN s.seats_assigned ELSE 0 END), 0)::int AS active

        FROM ai_subscription_plans p

        LEFT JOIN ai_seats s ON s.plan_id = p.plan_id`,

    );

    return { purchased: n(rows[0]?.purchased), active: n(rows[0]?.active) };

  }



  private async outcomeCountAll(

    tenantId: string,

    r: Range,

    tf: string,

    params: Record<string, ChParam>,

  ): Promise<number> {

    const rows = await this.ch.queryScoped<{ cnt: number }>(

      `SELECT count() AS cnt FROM agentledger.v_roi

       WHERE tenant_id = {tenant:String}

         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date} ${tf}`,

      params,

    );

    return n(rows[0]?.cnt);

  }



  private buildWarnings(ctx: {

    fullyLoadedCost: number;

    usageCost: number;

    businessValue: number;

    outcomeCount: number;

    totalOutcomesAll: number;

    minconf: number;

    unmappedCost: number;

    seatStats: { purchased: number; active: number };

    supplementalCost: number;

    copilotValue: number;

    cursorProductivityValue: number;

    costBasis: CostBasisMode;

    costProvenance: CostProvenance;

  }): string[] {

    const w: string[] = [];

    if (ctx.copilotValue > 0) {

      w.push(

        'Business value includes estimated GitHub Copilot productivity value — not exact measures from GitHub.',

      );

    }

    if (ctx.cursorProductivityValue > 0) {

      w.push(

        'Business value includes estimated Cursor productivity (accepted AI lines, tabs, composer/chat) from daily usage sync — not git commit revenue.',

      );

    }

    if (Math.abs(ctx.costProvenance.variancePct) > 2) {

      w.push(

        `Computed vs metered cost variance is ${ctx.costProvenance.variancePct.toFixed(1)}% — review provider billing imports.`,

      );

    }

    if (ctx.costBasis === 'metered' && ctx.costProvenance.meteredCoveragePct < 50) {

      w.push(

        `Metered cost basis selected but only ${ctx.costProvenance.meteredCoveragePct.toFixed(0)}% of provider/model keys have billed imports.`,

      );

    }

    if (ctx.fullyLoadedCost === 0 && ctx.usageCost > 0) {

      w.push('Fully-loaded cost is $0 but API usage exists — check outcome linkage and ROI templates.');

    }

    if (ctx.businessValue === 0 && ctx.totalOutcomesAll > 0) {

      w.push('Business value is $0 but outcomes exist — configure ROI templates or set business_value_usd.');

    }

    if (ctx.outcomeCount === 0 && ctx.totalOutcomesAll > 0 && ctx.minconf > 0) {

      w.push(`Confidence threshold ≥ ${ctx.minconf} removes all outcomes from headline metrics.`);

    }

    if (ctx.unmappedCost > 0) {

      w.push(
        `$${ctx.unmappedCost.toFixed(2)} in provider spend has no user assignment — open Settings → Connectors, expand your connector, and add a provider-user mapping if needed.`,
      );

    }

    if (ctx.seatStats.purchased > 0 && ctx.seatStats.active === 0) {

      w.push('Subscription seats are paid but no active seat assignments detected.');

    }

    if (ctx.usageCost > 0 && ctx.outcomeCount === 0) {

      w.push('Agent runs / usage exist but no outcomes are linked above the confidence threshold.');

    }

    if (ctx.supplementalCost > 0 && ctx.outcomeCount === 0) {

      w.push('Subscription or coding-agent costs are allocated but no attributed outcomes in period.');

    }

    return w;

  }

}



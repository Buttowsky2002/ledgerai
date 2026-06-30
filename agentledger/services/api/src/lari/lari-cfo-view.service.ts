import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam, ClickHouseService } from '../clickhouse/clickhouse.service';
import { CopilotAnalyticsService, COPILOT_ANALYTICS_PLATFORM } from '../github-copilot/github-copilot-analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import {
  CfoViewMonthly,
  CfoViewOutcomeBreakdown,
  CfoViewProviderBreakdown,
  CfoViewResponse,
  CfoViewSummary,
} from './lari-cfo-view.types';

type Range = { from: string; to: string };

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

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

/**
 * Tenant-level CFO view — aggregates the existing v_roi engine (no duplicate ROI
 * math) plus supplemental subscription and coding-agent costs from Postgres/CH.
 * Confidence threshold filters outcome links before aggregation (Phase 4 bar).
 */
@Injectable()
export class LariCfoViewService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly prisma: PrismaService,
    private readonly copilotAnalytics: CopilotAnalyticsService,
  ) {}

  async getCfoView(
    from?: string,
    to?: string,
    confidenceThreshold = 0.5,
    team?: string,
  ): Promise<CfoViewResponse> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const r = this.range(from, to, 365);
    const minconf = Math.max(0, Math.min(1, confidenceThreshold));
    const params: Record<string, ChParam> = { ...r, minconf };
    const tf = team ? ((params.team = team), 'AND team_id = {team:String}') : '';

    const [roiRows, providerRows, usageSpend, spendMonthly, codingAgentCost, subscriptionCost, seatStats, unmappedSpend, copilotSpend] =
      await Promise.all([
        this.ch.queryScoped<RoiAggRow>(
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
        ),
        this.ch.queryScoped<{ provider: string; cost_usd: number; calls: number }>(
          `SELECT provider, sum(cost_usd) AS cost_usd, sum(calls) AS calls
           FROM spend_daily
           WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
           GROUP BY provider ORDER BY cost_usd DESC`,
          params,
        ),
        this.ch.queryScoped<{ cost_usd: number; calls: number }>(
          `SELECT sum(cost_usd) AS cost_usd, sum(calls) AS calls
           FROM spend_daily
           WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
          params,
        ),
        this.ch.queryScoped<{ month: string; cost_usd: number }>(
          `SELECT toStartOfMonth(day) AS month, sum(cost_usd) AS cost_usd
           FROM spend_daily
           WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
           GROUP BY month ORDER BY month`,
          params,
        ),
        this.ch.queryScoped<{ cost_usd: number }>(
          `SELECT sum(cost_usd) AS cost_usd
           FROM agentledger.coding_agent_daily
           WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
          params,
        ),
        this.subscriptionCostForPeriod(tenantId, r),
        this.seatStats(tenantId),
        this.ch.queryScoped<{ unmapped_cost: number }>(
          `SELECT sum(cost_usd) AS unmapped_cost
           FROM spend_daily_by_user
           WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
             AND user_id = 'Unassigned'`,
          params,
        ),
        this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to),
      ]);

    const copilotCost = copilotSpend?.totalCostUsd ?? 0;
    const copilotValue = copilotSpend?.estimatedValueUsd ?? 0;
    const supplementalCost = n(codingAgentCost[0]?.cost_usd) + subscriptionCost + copilotCost;
    const usageCost = n(usageSpend[0]?.cost_usd);
    const outcomeCount = roiRows.reduce((s, row) => s + n(row.outcomes), 0);
    const totalOutcomesAll = await this.outcomeCountAll(tenantId, r, tf, params);

    const businessValue = roiRows.reduce((s, row) => s + n(row.value_usd), 0) + copilotValue;
    const outcomeFullyLoaded = roiRows.reduce((s, row) => s + n(row.fully_loaded_cost_usd), 0);
    const outcomeAiCost = roiRows.reduce((s, row) => s + n(row.ai_cost_usd), 0);
    const riskAdjustedValue = roiRows.reduce(
      (s, row) => s + n(row.risk_adjusted_roi_usd) + n(row.fully_loaded_cost_usd),
      0,
    );

    // Token/API usage from spend_daily; v_roi only covers AI cost on outcome-linked runs.
    // Add QA/eval/integration/platform from outcomes without double-counting token spend.
    const fullyLoadedCost = usageCost + supplementalCost + Math.max(0, outcomeFullyLoaded - outcomeAiCost);
    const nominalRoi = businessValue - fullyLoadedCost;
    const riskAdjustedRoi = riskAdjustedValue - fullyLoadedCost;

    const monthly = this.buildMonthly(roiRows, spendMonthly, supplementalCost);
    const runRateMonths = monthly.length;
    const forecastPerMonth = runRateMonths > 0 ? riskAdjustedRoi / runRateMonths : 0;
    const roiMargin = fullyLoadedCost > 0 ? riskAdjustedRoi / fullyLoadedCost : 0;

    const summary: CfoViewSummary = {
      riskAdjustedRoi: usd(riskAdjustedRoi),
      nominalRoi: usd(nominalRoi),
      businessValue: usd(businessValue),
      fullyLoadedCost: usd(fullyLoadedCost),
      forecastPerMonth: usd(forecastPerMonth),
      roiMargin: Math.round(roiMargin * 10_000) / 10_000,
      runRateMonths,
    };

    const outcomeBreakdown = this.buildOutcomeBreakdown(roiRows);
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
      usageCost: n(usageSpend[0]?.cost_usd),
      businessValue,
      outcomeCount,
      totalOutcomesAll,
      minconf,
      unmappedCost: n(unmappedSpend[0]?.unmapped_cost),
      seatStats,
      supplementalCost,
      copilotValue,
    });

    return {
      from: r.from,
      to: r.to,
      confidenceThreshold: minconf,
      summary,
      monthly,
      outcomeBreakdown,
      providerBreakdown,
      warnings,
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
    spendMonthly: { month: string; cost_usd: number }[],
    supplementalCost: number,
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
    for (const spend of spendMonthly) {
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
      const spendRow = spendMonthly.find((s) => String(s.month).slice(0, 7) === month);
      const monthUsage = n(spendRow?.cost_usd);
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

  private buildOutcomeBreakdown(rows: RoiAggRow[]): CfoViewOutcomeBreakdown[] {
    const byType = new Map<string, RoiAggRow>();
    for (const row of rows) {
      const t = String(row.outcome_type);
      const prev = byType.get(t);
      if (prev) {
        prev.outcomes = n(prev.outcomes) + n(row.outcomes);
        prev.value_usd = n(prev.value_usd) + n(row.value_usd);
        prev.fully_loaded_cost_usd = n(prev.fully_loaded_cost_usd) + n(row.fully_loaded_cost_usd);
        prev.nominal_roi_usd = n(prev.nominal_roi_usd) + n(row.nominal_roi_usd);
        prev.risk_adjusted_roi_usd = n(prev.risk_adjusted_roi_usd) + n(row.risk_adjusted_roi_usd);
        prev.avg_confidence = (n(prev.avg_confidence) + n(row.avg_confidence)) / 2;
      } else {
        byType.set(t, { ...row });
      }
    }
    return [...byType.entries()]
      .map(([outcomeType, row]) => ({
        outcomeType,
        outcomes: n(row.outcomes),
        businessValue: usd(n(row.value_usd)),
        fullyLoadedCost: usd(n(row.fully_loaded_cost_usd)),
        nominalRoi: usd(n(row.nominal_roi_usd)),
        riskAdjustedRoi: usd(n(row.risk_adjusted_roi_usd)),
        avgConfidence: Math.round(n(row.avg_confidence) * 100) / 100,
      }))
      .sort((a, b) => b.riskAdjustedRoi - a.riskAdjustedRoi);
  }

  /** Prorate subscription contract cost across the query window. */
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
  }): string[] {
    const w: string[] = [];
    if (ctx.copilotValue > 0) {
      w.push(
        'Business value includes estimated GitHub Copilot productivity value — not exact measures from GitHub.',
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
      w.push('Provider spend exists with unmapped users — assign user attribution for accurate allocation.');
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

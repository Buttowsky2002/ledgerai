import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { EFFECTIVE_METERED_COST_USD, LLM_CALLS_METERED_SCOPE } from '../connectors/metered-cost';
import { CopilotAnalyticsService } from '../github-copilot/github-copilot-analytics.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';
import { PrismaService } from '../prisma/prisma.service';
import {
  daysBetweenInclusive,
  periodDeltaPct,
  priorWindow,
} from './executive-report.should-render';
import { mergeCopilotSupplement, mergeProviderCostsSupplement } from './executive-report-supplemental';import type {
  DailySpendRow,
  ExecutiveReportData,
  ModelSpendRow,
  ProviderSpendRow,
  RiskRollupRow,
  SpendTotals,
  ValueMetrics,
} from './executive-report.types';
import { buildOneLiner, usd } from './formatters';
import { resolveUserIdentities, rollupUserSpendForChart } from './identity-resolver';
import { buildPlatformBreakdown } from './platform-breakdown';
import { buildModelSpendTable, buildUserSpendTable, buildTopModelMap } from './report-tables';

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const HEADLINE_CONF = 0.5;
// Same metered-spend definition the dashboard uses: provider-reported/invoice-grade
// cost only (no price-book estimates, no subscription-included usage value).
// Copilot is excluded here and merged from Postgres via mergeCopilotSupplement.
const METERED_COST = EFFECTIVE_METERED_COST_USD;

type Range = { from: string; to: string };

@Injectable()
export class ExecutiveReportService {
  constructor(
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
    private readonly copilotAnalytics: CopilotAnalyticsService,
  ) {}
  async build(from?: string, to?: string, requestedTenantId?: string): Promise<ExecutiveReportData> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    if (requestedTenantId && requestedTenantId !== tenantId) {
      throw new ForbiddenException('tenant_id does not match authenticated tenant');
    }

    const r = this.range(from, to);
    const prior = priorWindow(r.from, r.to);
    const days = daysBetweenInclusive(r.from, r.to);
    const p = r as Record<string, ChParam>;
    const priorP = { ...prior } as Record<string, ChParam>;

    const tenantRow = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { tenantId } }),
    );
    const currentTotals = await this.fetchSpendTotals(p);
    const priorTotals = await this.fetchSpendTotals(priorP);
    const spendTrend = await this.fetchDailySpend(p);
    const priorTrend = await this.fetchDailySpend(priorP);
    const userRows = await this.fetchUserSpend(p);
    const userModelRows = await this.fetchUserModelSpend(p);
    const providers = await this.fetchProviders(p);
    const models = await this.fetchModels(p);
    const providerCosts = await this.fetchProviderCosts(p);
    const riskRows = await this.fetchRisk(p);
    const blockedRow = await this.fetchBlockedEvents(p);
    const valueRow = await this.fetchValueMetrics(p);
    const [copilotSummary, copilotUserRows] = await Promise.all([
      this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to),
      this.copilotAnalytics.getUserSpendAllocation(tenantId, r.from, r.to),
    ]);

    const supplemental = mergeProviderCostsSupplement(providers, providerCosts);
    let current = currentTotals;
    current = {
      ...current,
      costUsd: usd(current.costUsd + supplemental.addedCostUsd),
      calls: current.calls + supplemental.addedCalls,
    };
    let mergedProviders = supplemental.providers;
    let mergedModels = models;
    let mergedSpendTrend = spendTrend;

    const copilotMerged = mergeCopilotSupplement(
      current,
      mergedProviders,
      mergedModels,
      mergedSpendTrend,
      copilotSummary,
    );
    current = copilotMerged.current;
    mergedProviders = copilotMerged.providers;
    mergedModels = copilotMerged.models;
    mergedSpendTrend = copilotMerged.spendTrend;    const flags = (tenantRow?.complianceFlags ?? {}) as Record<string, unknown>;
    const attributionLive = flags.attribution_mode === 'live' || flags.attribution_live === true;

    const priorSpend = priorTotals;    const totalTokens = current.inputTokens + current.outputTokens;
    const pctChangeVsPrior = periodDeltaPct(current.costUsd, priorSpend.costUsd);
    const costPer1kTokens = totalTokens > 0 ? usd((current.costUsd / totalTokens) * 1000) : null;

    let valueMetrics: ValueMetrics | null = null;
    if (attributionLive && valueRow.outcomes >= 1) {
      const lari =
        valueRow.fullyLoadedCostUsd > 0
          ? usd(valueRow.riskAdjustedRoiUsd / valueRow.fullyLoadedCostUsd)
          : null;
      valueMetrics = { ...valueRow, lari };
    }

    const allUserRows = [
      ...userRows,
      ...copilotUserRows.map((row) => ({
        userId: row.userId,
        costUsd: row.costUsd,
        calls: row.calls,
      })),
    ];
    const allUserModelRows = [
      ...userModelRows,
      ...copilotUserRows.map((row) => ({
        userId: row.userId,
        model: row.topModel,
        costUsd: row.costUsd,
      })),
    ];

    const resolvedUsers = await resolveUserIdentities(this.prisma, tenantId, allUserRows);
    const userSpend = rollupUserSpendForChart(resolvedUsers);
    const topModelByUserId = buildTopModelMap(allUserModelRows);
    const userSpendTable = buildUserSpendTable(resolvedUsers, topModelByUserId, current.costUsd);
    const modelSpendTable = buildModelSpendTable(mergedModels, current.costUsd);
    const platformBreakdown = buildPlatformBreakdown(mergedProviders, mergedModels);
    const oneLiner = buildOneLiner({
      totalCost: current.costUsd,
      priorCost: priorSpend.costUsd,
      pctChange: pctChangeVsPrior,
      calls: current.calls,
      attributionLive,
      netValue: valueMetrics?.netValueUsd ?? null,
      lari: valueMetrics?.lari ?? null,
    });

    return {
      tenantName: tenantRow?.name ?? 'Organization',
      window: { from: r.from, to: r.to, days },
      priorWindow: prior,
      attributionLive,
      current,
      prior: priorSpend,
      pctChangeVsPrior,
      costPer1kTokens,
      valueMetrics,
      spendTrend: mergedSpendTrend,
      priorSpendTrend: priorTrend,
      userSpend,
      userSpendTable,
      modelSpendTable,
      providers: mergedProviders,
      models: mergedModels,
      platformBreakdown,      risk: riskRows,
      blockedEvents: blockedRow,
      oneLiner,
    };
  }

  private range(from: string | undefined, to: string | undefined, defaultDays = 30): Range {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - defaultDays);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  private async fetchSpendTotals(params: Record<string, ChParam>): Promise<SpendTotals> {
    const rows = await this.ch.queryScoped<Record<string, unknown>>(
      `SELECT sum(${METERED_COST}) AS cost_usd,
              countIf(${METERED_COST} > 0) AS calls,
              sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cached_tokens
       FROM llm_calls
       WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}`,
      params,
    );
    const row = rows[0] ?? {};
    return {
      costUsd: usd(n(row.cost_usd)),
      calls: n(row.calls),
      inputTokens: n(row.input_tokens),
      outputTokens: n(row.output_tokens),
      cachedTokens: n(row.cached_tokens),
    };
  }

  private async fetchDailySpend(params: Record<string, ChParam>): Promise<DailySpendRow[]> {
    const rows = await this.ch.queryScoped<{ day: string; cost_usd: unknown }>(
      `SELECT toDate(ts) AS day, sum(${METERED_COST}) AS cost_usd
       FROM llm_calls
       WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}
       GROUP BY day ORDER BY day`,
      params,
    );
    return rows.map((row) => ({
      day: String(row.day).slice(0, 10),
      costUsd: usd(n(row.cost_usd)),
    }));
  }

  private async fetchUserSpend(
    params: Record<string, ChParam>,
  ): Promise<{ userId: string; costUsd: number; calls: number }[]> {
    const rows = await this.ch.queryScoped<{ user_id: string; cost_usd: unknown; calls: unknown }>(
      `SELECT user_id, sum(${METERED_COST}) AS cost_usd, countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}
       GROUP BY user_id
       HAVING cost_usd > 0
       ORDER BY cost_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      userId: String(row.user_id),
      costUsd: usd(n(row.cost_usd)),
      calls: n(row.calls),
    }));
  }

  private async fetchUserModelSpend(
    params: Record<string, ChParam>,
  ): Promise<{ userId: string; model: string; costUsd: number }[]> {
    const rows = await this.ch.queryScoped<{ user_id: string; model: string; cost_usd: unknown }>(
      `SELECT user_id,
              if(response_model != '', response_model, request_model) AS model,
              sum(${METERED_COST}) AS cost_usd
       FROM llm_calls
       WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}
       GROUP BY user_id, model
       HAVING cost_usd > 0
       ORDER BY user_id, cost_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      userId: String(row.user_id),
      model: String(row.model),
      costUsd: usd(n(row.cost_usd)),
    }));
  }

  private async fetchProviderCosts(params: Record<string, ChParam>): Promise<ProviderSpendRow[]> {
    const rows = await this.ch.queryScoped<{ provider: string; cost_usd: unknown }>(
      `SELECT provider, sum(cost_usd) AS cost_usd
       FROM provider_costs FINAL
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY provider ORDER BY cost_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      provider: String(row.provider),
      costUsd: usd(n(row.cost_usd)),
      calls: 0,
    }));
  }

  private async fetchProviders(params: Record<string, ChParam>): Promise<ProviderSpendRow[]> {
    const rows = await this.ch.queryScoped<{ provider: string; cost_usd: unknown; calls: unknown }>(
      `SELECT provider, sum(${METERED_COST}) AS cost_usd, countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}
       GROUP BY provider
       HAVING cost_usd > 0
       ORDER BY cost_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      provider: String(row.provider),
      costUsd: usd(n(row.cost_usd)),
      calls: n(row.calls),
    }));
  }

  private async fetchModels(params: Record<string, ChParam>): Promise<ModelSpendRow[]> {
    const rows = await this.ch.queryScoped<{ provider: string; model: string; cost_usd: unknown; calls: unknown }>(
      `SELECT provider,
              if(response_model != '', response_model, request_model) AS model,
              sum(${METERED_COST}) AS cost_usd,
              countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}
       GROUP BY provider, model
       HAVING cost_usd > 0
       ORDER BY provider, cost_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      provider: String(row.provider),
      model: String(row.model),
      costUsd: usd(n(row.cost_usd)),
      calls: n(row.calls),
    }));
  }

  private async fetchRisk(params: Record<string, ChParam>): Promise<RiskRollupRow[]> {
    const rows = await this.ch.queryScoped<{ dlp_action: string; risk_severity: string; events: unknown }>(
      `SELECT dlp_action, risk_severity, sum(events) AS events
       FROM risk_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY dlp_action, risk_severity ORDER BY events DESC`,
      params,
    );
    return rows.map((row) => ({
      dlpAction: String(row.dlp_action),
      riskSeverity: String(row.risk_severity),
      events: n(row.events),
    }));
  }

  private async fetchBlockedEvents(params: Record<string, ChParam>): Promise<number> {
    const rows = await this.ch.queryScoped<{ blocked_events: unknown }>(
      `SELECT sum(events) AS blocked_events
       FROM risk_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         AND dlp_action = 'block'`,
      params,
    );
    return n(rows[0]?.blocked_events);
  }

  private async fetchValueMetrics(params: Record<string, ChParam>): Promise<Omit<ValueMetrics, 'lari'>> {
    const rows = await this.ch.queryScoped<Record<string, unknown>>(
      `SELECT count() AS outcomes,
              sum(value_usd) AS business_value_usd,
              sum(fully_loaded_cost_usd) AS total_fully_loaded_cost_usd,
              sum(risk_adjusted_roi_usd) AS risk_adjusted_roi_usd,
              avg(attribution_confidence) AS avg_confidence
       FROM agentledger.v_roi
       WHERE tenant_id = {tenant:String}
         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}
         AND attribution_confidence >= {minconf:Float32}`,
      { ...params, minconf: HEADLINE_CONF },
    );
    const row = rows[0] ?? {};
    const businessValueUsd = usd(n(row.business_value_usd));
    const fullyLoadedCostUsd = usd(n(row.total_fully_loaded_cost_usd));
    return {
      outcomes: n(row.outcomes),
      businessValueUsd,
      fullyLoadedCostUsd,
      netValueUsd: usd(businessValueUsd - fullyLoadedCostUsd),
      riskAdjustedRoiUsd: usd(n(row.risk_adjusted_roi_usd)),
      avgConfidence: n(row.avg_confidence),
    };
  }

  async auditExport(tenantId: string, from: string, to: string, format: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actor: getPrincipal()?.userId ?? 'system',
          action: 'export',
          object: `executive-report:${from}:${to}:${format}`,
          detail: { from, to, format },
        },
      }),
    );
  }
}
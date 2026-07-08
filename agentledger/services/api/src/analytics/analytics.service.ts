import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { CopilotAnalyticsService, CopilotSpendSummary } from '../github-copilot/github-copilot-analytics.service';
import { CursorAnalyticsService, CursorSpendSummary } from '../connectors/cursor-analytics.service';
import { CopilotMemberSpendService } from '../github-copilot/github-copilot-member-spend.service';
import type { CopilotMemberSpendResponse } from '../github-copilot/github-copilot.types';
import { LariService } from '../lari/lari.service';
import { Recommendation } from '../lari/lari.types';
import { PrismaService } from '../prisma/prisma.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';

/** One row of the per-agent economics rollup (GET /v1/analytics/agent-economics). */
export interface AgentEconomicsRow {
  agentId: string;
  cost_usd: number;
  value_usd: number;
  risk_adjusted_roi: number;
  lari: number;
  confidenceScore: number;
  recommendation: Recommendation;
}
import { FocusRow, SpendDailyRow, toFocusRow } from './focus.mapper';
import { PilotReport } from './report.renderer';
import { computeSpendTrend } from './spend-trend';
import { EFFECTIVE_METERED_COST_USD, LLM_CALLS_METERED_SCOPE } from '../connectors/metered-cost';
import { sumProratedMonthlyCosts } from '../fixed-costs/fixed-cost-prorate';
import { loadIdentityLookups, resolveUserDirectoryIdentity, isEmailLike } from '../reports/identity-resolver';
import type { UserDirectoryIdentity } from '../reports/identity-resolver';

type Range = { from: string; to: string };

/** One day of portal vs API spend for reconciliation (Admin billing import). */
export interface SourceReconciliationDay {
  day: string;
  portalCostUsd: number;
  portalCalls: number;
  apiCostUsd: number;
  apiCalls: number;
}

export interface SourceReconciliationResult {
  from: string;
  to: string;
  days: SourceReconciliationDay[];
  summary: {
    portalTotalUsd: number;
    apiTotalUsd: number;
    overlapDays: number;
    portalOnlyDays: number;
    apiOnlyDays: number;
  };
}

export interface UserModelBreakdownRow {
  model: string;
  platform: string;
  spend_usd: number;
  calls: number;
}

export interface UserDirectoryRow {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
  resolved: boolean;
  total_spend_usd: number;
  calls: number;
  models: string[];
  model_breakdown: UserModelBreakdownRow[];
}

export interface AnalyticsDataBounds {
  earliest_day: string;
  latest_day: string;
}

export interface UsersAnalyticsResult {
  from: string;
  to: string;
  users: UserDirectoryRow[];
  /** How many distinct users came from each spend source before merge. */
  sources: {
    llm_call_users: number;
    copilot_members: number;
  };
}

type CopilotIdentityHint = { displayName: string | null; email: string | null; team: string };

/** Coerce a ClickHouse scalar (numbers may arrive as strings) to a number. */
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

const METERED_COST = EFFECTIVE_METERED_COST_USD;

/**
 * Read-only analytics over the ClickHouse materialized views — NEVER raw
 * llm_calls (spec §3). Every query goes through ClickHouseService.queryScoped, so
 * `tenant_id = {tenant:String}` is bound from the JWT principal (the sole tenant
 * isolation mechanism in ClickHouse). All other inputs are bound parameters too.
 * MVs are SummingMergeTree, so queries re-aggregate with sum()/GROUP BY.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
    private readonly lari: LariService,
    private readonly copilotAnalytics: CopilotAnalyticsService,
    private readonly copilotMemberSpend: CopilotMemberSpendService,
    private readonly cursorAnalytics: CursorAnalyticsService,
  ) {}

  /**
   * FOCUS 1.2 cost export (ADR-035) — one record per (day, team, app, provider,
   * model) from spend_daily, mapped to FOCUS columns + x_ai_* extensions. The
   * export is a data egress, so it is recorded in audit_log (rule 10).
   */
  async focusExport(from?: string, to?: string): Promise<FocusRow[]> {
    const r = this.range(from, to);
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const rows = await this.ch.queryScoped<SpendDailyRow>(
      `SELECT day, team_id, app_id, provider, model,
              sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(cached_tokens) AS cached_tokens, sum(cost_usd) AS cost_usd, sum(calls) AS calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY day, team_id, app_id, provider, model
       ORDER BY day, team_id, app_id, provider, model`,
      r as Record<string, ChParam>,
    );
    const focus = rows.map((row) => toFocusRow(row, { tenantId, from: r.from, to: r.to }));
    await this.auditExport(tenantId, r, focus.length);
    return focus;
  }

  // Records the export as an administrative data-egress event. Written inside an
  // explicit tenant-bound transaction so RLS WITH CHECK passes (the analytics
  // path has a request principal, but recordAudit's create/update/delete vocab
  // doesn't cover 'export', so the row is written directly).
  private async auditExport(tenantId: string, r: Range, rowCount: number): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actor: getPrincipal()?.userId ?? 'system',
          action: 'export',
          object: `focus-export:${r.from}:${r.to}`,
          detail: { rows: rowCount, from: r.from, to: r.to },
        },
      }),
    );
  }

  /** Resolve an optional ISO-date range, defaulting to the last `days` days. */
  private range(from: string | undefined, to: string | undefined, days = 90): Range {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  /** Optional team filter: returns the SQL fragment and stamps the param. */
  private teamFilter(team: string | undefined, params: Record<string, ChParam>, col = 'team_id'): string {
    if (!team) return '';
    params.team = team;
    return `AND ${col} = {team:String}`;
  }

  spend(from?: string, to?: string, team?: string) {
    const r = this.range(from, to);
    const params = { ...r } as Record<string, ChParam>;
    const tf = this.teamFilter(team, params);
    return this.ch
      .queryScoped<SpendDailyRow>(
        `SELECT toDate(ts) AS day,
                sum(${METERED_COST}) AS cost_usd,
                countIf(${METERED_COST} > 0) AS calls,
                sum(input_tokens + output_tokens) AS tokens,
                countIf(status LIKE 'blocked%') AS blocked_calls,
                countIf(status = 'upstream_error') AS error_calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE} ${tf}
         GROUP BY day ORDER BY day`,
        params,
      )
      .then((rows) => this.mergeCopilotDailySpend(rows, r, team));
  }

  /**
   * Earliest selectable analytics day for the tenant: first metered spend, first
   * connector sync with imported records, or first AI provider connection.
   */
  async dataBounds(): Promise<AnalyticsDataBounds> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const latest_day = iso(new Date());

    const spendRow = await this.ch
      .queryScoped<{ earliest: string | null }>(
        `SELECT min(day) AS earliest FROM spend_daily WHERE tenant_id = {tenant:String}`,
        { tenant: tenantId },
      )
      .then((rows) => rows[0]);
    const byUserRow = await this.ch
      .queryScoped<{ earliest: string | null }>(
        `SELECT min(day) AS earliest FROM spend_daily_by_user WHERE tenant_id = {tenant:String}`,
        { tenant: tenantId },
      )
      .then((rows) => rows[0]);
    const llmRow = await this.ch
      .queryScoped<{ earliest: string | null }>(
        `SELECT min(toDate(ts)) AS earliest FROM llm_calls WHERE tenant_id = {tenant:String}`,
        { tenant: tenantId },
      )
      .then((rows) => rows[0]);
    const { syncMin, connectionMin } = await this.prisma.withTenant(tenantId, async (tx) => {
      const [syncMin, connectionMin] = await Promise.all([
        tx.connectorSyncRun.aggregate({
          _min: { startedAt: true },
          where: { recordsImported: { gt: 0 } },
        }),
        tx.aiProviderConnection.aggregate({ _min: { createdAt: true } }),
      ]);
      return { syncMin, connectionMin };
    });

    const candidates: string[] = [];
    if (spendRow?.earliest) candidates.push(String(spendRow.earliest).slice(0, 10));
    if (byUserRow?.earliest) candidates.push(String(byUserRow.earliest).slice(0, 10));
    if (llmRow?.earliest) candidates.push(String(llmRow.earliest).slice(0, 10));
    if (syncMin._min.startedAt) candidates.push(iso(syncMin._min.startedAt));
    if (connectionMin._min.createdAt) candidates.push(iso(connectionMin._min.createdAt));

    const fallbackFrom = iso(new Date(Date.now() - 90 * 86400000));
    const earliest_day = candidates.length > 0 ? candidates.sort()[0]! : fallbackFrom;
    return { earliest_day, latest_day };
  }

  /** GitHub Copilot spend for a period — used by cost-per-outcome supplemental AI cost. */
  async copilotSpend(from?: string, to?: string): Promise<CopilotSpendSummary | null> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const r = this.range(from, to, 365);
    return this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to);
  }

  private async mergeCopilotDailySpend<T extends { day: string; cost_usd: unknown }>(
    chRows: T[],
    r: Range,
    team?: string,
  ): Promise<T[]> {
    if (team) return chRows;
    const tenantId = getTenantId();
    if (!tenantId) return chRows;
    const copilot = await this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to);
    if (!copilot || copilot.totalCostUsd <= 0) return chRows;

    const dayMap = new Map<string, T>();
    for (const row of chRows) {
      dayMap.set(String(row.day).slice(0, 10), row);
    }
    for (const d of copilot.daily) {
      const existing = dayMap.get(d.day);
      if (existing) {
        (existing as { cost_usd: number }).cost_usd = n(existing.cost_usd) + d.cost_usd;
      } else {
        dayMap.set(d.day, {
          day: d.day,
          cost_usd: d.cost_usd,
          calls: 0,
          tokens: 0,
          blocked_calls: 0,
          error_calls: 0,
        } as unknown as T);
      }
    }
    return [...dayMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  /** Cursor on-demand overage vs subscription usage value (Admin API). */
  async cursorSpend(from?: string, to?: string): Promise<CursorSpendSummary | null> {
    const r = this.range(from, to);
    const tenantId = getTenantId();
    if (!tenantId) return Promise.resolve(null);
    const summary = await this.cursorAnalytics.getSpendSummary(tenantId, r.from, r.to);
    if (!summary) return null;

    let seat: {
      seatLicenseUsd: number;
      seatCount: number;
      seatUnitUsdPerMonth: number;
      seatSource: 'fixed_costs' | 'subscription_plan' | 'none';
    } = {
      seatLicenseUsd: 0,
      seatCount: 0,
      seatUnitUsdPerMonth: 0,
      seatSource: 'none',
    };
    let activeMembers = 0;
    try {
      const [seatResult, members] = await Promise.all([
        this.cursorSeatLicenseForPeriod(tenantId, r),
        this.cursorActiveMembers(tenantId, r),
      ]);
      seat = seatResult;
      activeMembers = members;
    } catch (err) {
      this.logger.warn(
        { event: 'cursor_spend_enrichment_failed', err: String((err as Error)?.message ?? err) },
        'cursor-spend seat/active-member enrichment failed; returning usage summary',
      );
    }

    return {
      ...summary,
      seatLicenseUsd: seat.seatLicenseUsd,
      seatCount: seat.seatCount,
      seatUnitUsdPerMonth: seat.seatUnitUsdPerMonth,
      seatSource: seat.seatSource,
      activeMembersInRange: activeMembers,
      meteredOverageUsd: summary.billedUsd,
    };
  }

  /** Seat/subscription license cost for Cursor — fixed_costs first, then ai_subscription_plans. */
  private async cursorSeatLicenseForPeriod(
    tenantId: string,
    r: Range,
  ): Promise<{
    seatLicenseUsd: number;
    seatCount: number;
    seatUnitUsdPerMonth: number;
    seatSource: 'fixed_costs' | 'subscription_plan' | 'none';
  }> {
    const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
    const usd = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

    const fixedRows = await this.ch.queryScoped<{
      cost_usd: unknown;
      seats: unknown;
      unit_cost_usd: unknown;
      period_month: string;
    }>(
      `SELECT period_month, sum(cost_usd) AS cost_usd,
              sum(seats) AS seats,
              if(sum(seats) > 0, sum(cost_usd) / sum(seats), max(unit_cost_usd)) AS unit_cost_usd
       FROM agentledger.fixed_costs FINAL
       WHERE tenant_id = {tenant:String}
         AND lower(vendor) = 'cursor'
         AND cost_type IN ('seat_license', 'subscription')
         AND period_month >= toStartOfMonth(toDate({from:String}))
         AND period_month <= toStartOfMonth(toDate({to:String}))
         AND attributable = 0
       GROUP BY period_month`,
      { from: r.from, to: r.to },
    );
    const fixedCost = sumProratedMonthlyCosts(
      fixedRows.map((row) => ({
        period_month: String(row.period_month),
        cost_usd: n(row.cost_usd),
      })),
      r.from,
      r.to,
    );
    if (fixedCost > 0) {
      const seats = fixedRows.reduce((s, row) => s + n(row.seats), 0);
      const monthlyTotal = fixedRows.reduce((s, row) => s + n(row.cost_usd), 0);
      return {
        seatLicenseUsd: usd(fixedCost),
        seatCount: Math.round(seats),
        seatUnitUsdPerMonth: usd(seats > 0 ? monthlyTotal / seats : n(fixedRows[0]?.unit_cost_usd)),
        seatSource: 'fixed_costs',
      };
    }

    const plans = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<
        {
          seats_purchased: number;
          monthly_price_per_user: number | string;
          contract_monthly_cost: number | string;
        }[]
      >`
        SELECT seats_purchased, monthly_price_per_user, contract_monthly_cost
        FROM ai_subscription_plans
        WHERE lower(provider) = 'cursor'
          AND (contract_monthly_cost > 0 OR monthly_price_per_user > 0)`,
    );
    if (plans.length === 0) {
      return { seatLicenseUsd: 0, seatCount: 0, seatUnitUsdPerMonth: 0, seatSource: 'none' };
    }

    const seats = plans.reduce((s, p) => s + n(p.seats_purchased), 0);
    const monthlyTotal = plans.reduce((s, p) => {
      const contract = n(p.contract_monthly_cost);
      if (contract > 0) return s + contract;
      return s + n(p.monthly_price_per_user) * n(p.seats_purchased);
    }, 0);
    const periodDays = Math.max(
      1,
      (new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000 + 1,
    );
    const monthsInWindow = periodDays / 30.437;
    const unit =
      seats > 0 ? monthlyTotal / seats : n(plans[0]?.monthly_price_per_user);
    return {
      seatLicenseUsd: usd(monthlyTotal * monthsInWindow),
      seatCount: seats,
      seatUnitUsdPerMonth: usd(unit),
      seatSource: 'subscription_plan',
    };
  }

  private async cursorActiveMembers(tenantId: string, r: Range): Promise<number> {
    const rows = await this.ch.queryScoped<{ members: unknown }>(
      `SELECT count(DISTINCT user_id) AS members
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}`,
      { tenant: tenantId, from: r.from, to: r.to },
    );
    return Number(rows[0]?.members ?? 0);
  }

  private async mergeCopilotPlatformSpend(
    chRows: { platform: string; cost_usd: unknown; calls: unknown }[],
    r: Range,
  ) {
    const tenantId = getTenantId();
    if (!tenantId) return chRows;
    const copilot = await this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to);
    if (!copilot || copilot.totalCostUsd <= 0) return chRows;

    const rows = chRows.map((row) => ({
      platform: String(row.platform),
      cost_usd: n(row.cost_usd),
      calls: n(row.calls),
    }));
    const idx = rows.findIndex((r) => r.platform === copilot.platform.platform);
    if (idx >= 0) {
      rows[idx].cost_usd = usd(rows[idx].cost_usd + copilot.platform.cost_usd);
      rows[idx].calls += copilot.platform.calls;
    } else {
      rows.push({ ...copilot.platform });
    }
    return rows.sort((a, b) => b.cost_usd - a.cost_usd);
  }

  private async mergeCopilotModelMix(
    chRows: { provider: string; model: string; cost_usd: unknown; calls: unknown }[],
    r: Range,
  ) {
    const tenantId = getTenantId();
    if (!tenantId) return chRows;
    const copilot = await this.copilotAnalytics.getSpendSummary(tenantId, r.from, r.to);
    if (!copilot || copilot.totalCostUsd <= 0) return chRows;

    const rows = chRows.map((row) => ({
      provider: String(row.provider),
      model: String(row.model),
      cost_usd: n(row.cost_usd),
      calls: n(row.calls),
    }));
    for (const m of copilot.modelMix) {
      const idx = rows.findIndex((r) => r.provider === m.provider && r.model === m.model);
      if (idx >= 0) {
        rows[idx].cost_usd = usd(rows[idx].cost_usd + m.cost_usd);
        rows[idx].calls += m.calls;
      } else {
        rows.push({ ...m });
      }
    }
    return rows.sort((a, b) => b.cost_usd - a.cost_usd);
  }

  allocation(dimension: 'team' | 'app' | 'agent' | 'user', from?: string, to?: string) {
    const r = this.range(from, to);
    if (dimension === 'user') {
      return this.userAllocationWithTrend(r);
    }
    if (dimension === 'agent') {
      return this.ch.queryScoped(
        `SELECT agent_id AS key, sum(cost_usd) AS cost_usd, sum(calls) AS calls
         FROM spend_hourly_by_key
         WHERE tenant_id = {tenant:String} AND toDate(hour) BETWEEN {from:Date} AND {to:Date}
         GROUP BY agent_id ORDER BY cost_usd DESC`,
        r as Record<string, ChParam>,
      );
    }
    const col = dimension === 'team' ? 'team_id' : 'app_id';
    return this.ch.queryScoped(
      `SELECT ${col} AS key,
              sum(${METERED_COST}) AS cost_usd,
              countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND ${LLM_CALLS_METERED_SCOPE}
       GROUP BY ${col} ORDER BY cost_usd DESC`,
      r as Record<string, ChParam>,
    );
    // NOTE: `col` is a fixed identifier from a validated enum (never user text),
    // so this is not dynamic SQL from input; all values remain bound parameters.
  }

  /** User allocation rows include daily-spend trend (latter half vs first half of range). */
  private async userAllocationWithTrend(r: Range) {
    const tenantId = getTenantId();
    const params = r as Record<string, ChParam>;
    const [totals, daily, codingTotals, codingDaily, copilotPack] = await Promise.all([
      this.ch.queryScoped<{ key: string; cost_usd: unknown; calls: unknown }>(
        `SELECT if(user_id = '', 'Unassigned', user_id) AS key,
                sum(${METERED_COST}) AS cost_usd,
                countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE}
         GROUP BY key ORDER BY cost_usd DESC`,
        params,
      ),
      this.ch.queryScoped<{ user_id: string; day: string; cost_usd: unknown }>(
        `SELECT if(user_id = '', 'Unassigned', user_id) AS user_id,
                toDate(ts) AS day,
                sum(${METERED_COST}) AS cost_usd
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE}
         GROUP BY user_id, day
         ORDER BY user_id, day`,
        params,
      ),
      this.ch.queryScoped<{ key: string; cost_usd: unknown; calls: unknown }>(
        `SELECT if(user_id = '', 'Unassigned', user_id) AS key,
                sum(cost_usd) AS cost_usd,
                sum(requests) AS calls
         FROM coding_agent_daily
         WHERE tenant_id = {tenant:String}
           AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY key
         HAVING cost_usd > 0`,
        params,
      ),
      this.ch.queryScoped<{ user_id: string; day: string; cost_usd: unknown }>(
        `SELECT if(user_id = '', 'Unassigned', user_id) AS user_id,
                day,
                sum(cost_usd) AS cost_usd
         FROM coding_agent_daily
         WHERE tenant_id = {tenant:String}
           AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY user_id, day
         HAVING cost_usd > 0
         ORDER BY user_id, day`,
        params,
      ),
      tenantId ? this.fetchCopilotUserSpend(tenantId, r) : Promise.resolve({ totals: [], breakdown: [], hints: new Map() }),
    ]);

    const totalsMap = new Map<string, { cost_usd: number; calls: number }>();
    for (const row of totals) {
      totalsMap.set(String(row.key), { cost_usd: n(row.cost_usd), calls: n(row.calls) });
    }
    for (const row of codingTotals) {
      const key = String(row.key);
      const cur = totalsMap.get(key) ?? { cost_usd: 0, calls: 0 };
      totalsMap.set(key, {
        cost_usd: usd(cur.cost_usd + n(row.cost_usd)),
        calls: cur.calls + n(row.calls),
      });
    }
    for (const row of copilotPack.totals) {
      const key = String(row.user_id);
      const cur = totalsMap.get(key) ?? { cost_usd: 0, calls: 0 };
      totalsMap.set(key, {
        cost_usd: usd(cur.cost_usd + n(row.total_spend_usd)),
        calls: cur.calls + n(row.calls),
      });
    }

    const dailyByUser = new Map<string, Map<string, number>>();
    const addDaily = (userId: string, day: string, cost: number) => {
      const uid = String(userId);
      const dayKey = day.slice(0, 10);
      const perUser = dailyByUser.get(uid) ?? new Map<string, number>();
      perUser.set(dayKey, usd((perUser.get(dayKey) ?? 0) + cost));
      dailyByUser.set(uid, perUser);
    };
    for (const row of daily) {
      addDaily(String(row.user_id), String(row.day), n(row.cost_usd));
    }
    for (const row of codingDaily) {
      addDaily(String(row.user_id), String(row.day), n(row.cost_usd));
    }

    return [...totalsMap.entries()]
      .map(([key, agg]) => {
        const dayMap = dailyByUser.get(key);
        const trend = computeSpendTrend(
          dayMap
            ? [...dayMap.entries()].map(([day, cost_usd]) => ({ day, cost_usd }))
            : [],
        );
        return {
          key,
          cost_usd: agg.cost_usd,
          calls: agg.calls,
          spend_trend: trend.direction,
          ...(trend.change_pct != null ? { trend_change_pct: trend.change_pct } : {}),
          ...(trend.change_usd != null ? { trend_change_usd: trend.change_usd } : {}),
        };
      })
      .sort((a, b) => b.cost_usd - a.cost_usd);
  }

  modelMix(from?: string, to?: string) {
    const r = this.range(from, to);
    return this.ch
      .queryScoped<{ provider: string; model: string; cost_usd: unknown; calls: unknown }>(
        `SELECT provider,
                if(response_model != '', response_model, request_model) AS model,
                sum(${METERED_COST}) AS cost_usd,
                countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE}
         GROUP BY provider, model ORDER BY cost_usd DESC`,
        r as Record<string, ChParam>,
      )
      .then((rows) => this.mergeCopilotModelMix(rows, r));
  }

  /** Spend grouped by provider/platform — powers Overview and Model Mix pie charts. */
  platformSpend(from?: string, to?: string) {
    const r = this.range(from, to);
    return this.ch
      .queryScoped<{ platform: string; cost_usd: unknown; calls: unknown }>(
        `SELECT provider AS platform,
                sum(${METERED_COST}) AS cost_usd,
                countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE}
         GROUP BY provider ORDER BY cost_usd DESC`,
        r as Record<string, ChParam>,
      )
      .then((rows) => this.mergeCopilotPlatformSpend(rows, r));
  }

  burndown(from?: string, to?: string, virtualKeyId?: string) {
    const r = this.range(from, to);
    const filter = virtualKeyId ? 'AND virtual_key_id = {vkey:String}' : '';
    const params: Record<string, ChParam> = { ...r };
    if (virtualKeyId) {
      params.vkey = virtualKeyId;
    }
    return this.ch.queryScoped(
      `SELECT hour, sum(cost_usd) AS hourly_cost_usd,
              sum(sum(cost_usd)) OVER (ORDER BY hour) AS cumulative_cost_usd
       FROM spend_hourly_by_key
       WHERE tenant_id = {tenant:String} AND toDate(hour) BETWEEN {from:Date} AND {to:Date} ${filter}
       GROUP BY hour ORDER BY hour`,
      params,
    );
  }

  risk(from?: string, to?: string, team?: string) {
    const r = this.range(from, to);
    const params = { ...r } as Record<string, ChParam>;
    const tf = this.teamFilter(team, params);
    return this.ch.queryScoped(
      `SELECT day, dlp_action, risk_severity, sum(events) AS events
       FROM risk_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date} ${tf}
       GROUP BY day, dlp_action, risk_severity ORDER BY day`,
      params,
    );
  }

  // Cost per outcome, filtered by attribution confidence. Queries the base
  // outcomes/agent_runs tables (NOT v_unit_economics) so a per-outcome
  // confidence threshold can exclude rows BEFORE aggregation — the headline
  // cost_per_outcome ratio stays correct. FINAL collapses the attribution
  // matcher's re-inserted rows (same approach as agentDetail's agent_runs FINAL).
  // minConfidence defaults to 0 (include all, incl. unattributed outcomes).
  unitEconomics(from?: string, to?: string, outcomeType?: string, minConfidence = 0, team?: string) {
    const r = this.range(from, to, 365);
    const filter = outcomeType ? 'AND o.outcome_type = {otype:String}' : '';
    const params: Record<string, ChParam> = { ...r, minconf: minConfidence };
    if (outcomeType) {
      params.otype = outcomeType;
    }
    const tf = this.teamFilter(team, params, 'o.team_id');
    return this.ch.queryScoped(
      `SELECT toStartOfMonth(o.ts) AS month, o.outcome_type AS outcome_type, o.team_id AS team_id,
              count() AS outcomes,
              sum(r.total_cost_usd) AS ai_cost_usd,
              sum(o.business_value_usd) AS business_value_usd,
              sum(r.total_cost_usd) / nullIf(count(), 0) AS cost_per_outcome,
              sum(o.business_value_usd) - sum(r.total_cost_usd) AS net_value_usd,
              avg(o.attribution_confidence) AS avg_confidence
       FROM agentledger.outcomes o FINAL
       LEFT JOIN agentledger.agent_runs r FINAL
         ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
       WHERE o.tenant_id = {tenant:String}
         AND toStartOfMonth(o.ts) BETWEEN toStartOfMonth(toDate({from:Date})) AND toStartOfMonth(toDate({to:Date}))
         AND o.attribution_confidence >= {minconf:Float32} ${filter} ${tf}
       GROUP BY month, outcome_type, team_id ORDER BY month`,
      params,
    );
  }

  // Finance-grade ROI from the v_roi engine (baseline value, fully-loaded cost,
  // confidence-weighted + risk-adjusted ROI). Aggregated per month/outcome_type.
  // Headline excludes low-confidence links by default (minConfidence 0.5) per the
  // Phase 4 acceptance bar; callers can pass 0 to see everything.
  roi(from?: string, to?: string, outcomeType?: string, minConfidence = 0.5, team?: string) {
    const r = this.range(from, to, 365);
    const filter = outcomeType ? 'AND outcome_type = {otype:String}' : '';
    const params: Record<string, ChParam> = { ...r, minconf: minConfidence };
    if (outcomeType) {
      params.otype = outcomeType;
    }
    const tf = this.teamFilter(team, params); // v_roi exposes team_id (migration 011)
    return this.ch.queryScoped(
      `SELECT toStartOfMonth(outcome_ts) AS month, outcome_type AS outcome_type,
              count() AS outcomes,
              sum(value_usd) AS value_usd,
              sum(fully_loaded_cost_usd) AS fully_loaded_cost_usd,
              sum(nominal_roi_usd) AS nominal_roi_usd,
              sum(expected_roi_usd) AS expected_roi_usd,
              sum(risk_adjusted_roi_usd) AS risk_adjusted_roi_usd,
              avg(attribution_confidence) AS avg_confidence,
              avg(risk_exposure_pct) AS avg_risk_exposure
       FROM agentledger.v_roi
       WHERE tenant_id = {tenant:String}
         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}
         AND attribution_confidence >= {minconf:Float32} ${filter} ${tf}
       GROUP BY month, outcome_type ORDER BY month`,
      params,
    );
  }

  /**
   * Per-agent economics rollup powering the overview's recommendations panel and
   * unit-economics table. For each agent that produced outcomes in the window it
   * runs the LARI engine, so the recommendation/confidence match /v1/agents/:id/lari.
   * Capped at the top 25 agents by attributed value (logged when capped — never a
   * silent truncation); the per-agent LARI rollup is not team-scoped.
   */
  async agentEconomics(from?: string, to?: string): Promise<AgentEconomicsRow[]> {
    const r = this.range(from, to, 365);
    const agents = await this.ch.queryScoped<{ agent_id: string }>(
      `SELECT agent_id, sum(value_usd) AS value_usd
       FROM agentledger.v_agent_daily_unit_economics
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY agent_id ORDER BY value_usd DESC`,
      r as Record<string, ChParam>,
    );
    const CAP = 25;
    const capped = agents.slice(0, CAP);
    if (agents.length > CAP) {
      this.logger.warn(`agent-economics: showing top ${CAP} of ${agents.length} agents by value`);
    }
    const rows = await Promise.all(
      capped.map(async (a): Promise<AgentEconomicsRow> => {
        const result = await this.lari.computeForAgent(a.agent_id, r.from, r.to);
        return {
          agentId: a.agent_id,
          cost_usd: result.fullyLoadedCostUsd,
          value_usd: result.attributedIncrementalValueUsd,
          risk_adjusted_roi: result.netValueUsd,
          lari: result.lari,
          confidenceScore: result.confidenceScore,
          recommendation: result.recommendation,
        };
      }),
    );
    return rows.sort((x, y) => y.risk_adjusted_roi - x.risk_adjusted_roi);
  }

  // CISO agent risk register (Phase 5): per agent, its risk_exposure_pct plus the
  // governed risk events behind it. Drives the CISO governance view. Empty until
  // the risk-engine has run.
  agentRisk() {
    return this.ch.queryScoped(
      `SELECT
         e.agent_id AS agent_id,
         any(r.risk_exposure_pct) AS risk_exposure_pct,
         count() AS events,
         countIf(e.severity = 'high') AS high_severity,
         argMax(e.detail, e.detected_at) AS latest_detail,
         argMax(e.category, e.detected_at) AS latest_category,
         max(e.detected_at) AS last_detected
       FROM agentledger.risk_events e FINAL
       LEFT JOIN agentledger.agent_risk r FINAL
         ON r.tenant_id = e.tenant_id AND r.agent_id = e.agent_id
       WHERE e.tenant_id = {tenant:String}
       GROUP BY e.agent_id
       ORDER BY risk_exposure_pct DESC, events DESC`,
    );
  }

  /**
   * CISO injection posture (ADR-048): per agent, inline gateway blocks
   * (status = blocked_injection) union semantic flags (semantic_injection_suspected).
   */
  injectionPosture() {
    return this.ch.queryScoped(
      `SELECT
         coalesce(b.agent_id, s.agent_id) AS agent_id,
         coalesce(b.blocked_count, 0) AS blocked_count,
         b.last_blocked,
         coalesce(s.flagged_count, 0) AS flagged_count,
         coalesce(s.high_severity, 0) AS high_severity,
         s.latest_detail,
         s.last_detected
       FROM (
         SELECT agent_id, count() AS blocked_count, max(ts) AS last_blocked
         FROM agentledger.llm_calls FINAL
         WHERE tenant_id = {tenant:String}
           AND status = 'blocked_injection'
           AND agent_id != ''
         GROUP BY agent_id
       ) b
       FULL OUTER JOIN (
         SELECT
           agent_id,
           count() AS flagged_count,
           countIf(severity = 'high') AS high_severity,
           argMax(detail, detected_at) AS latest_detail,
           max(detected_at) AS last_detected
         FROM agentledger.risk_events FINAL
         WHERE tenant_id = {tenant:String}
           AND category = 'semantic_injection_suspected'
         GROUP BY agent_id
       ) s ON b.agent_id = s.agent_id
       ORDER BY blocked_count + flagged_count DESC`,
    );
  }

  async agentDetail(agentId: string, from?: string, to?: string) {
    if (!agentId) {
      throw new BadRequestException('agentId required');
    }
    const r = this.range(from, to);
    const params: Record<string, ChParam> = { ...r, agent: agentId };
    const [spend, runs, statusMix] = await Promise.all([
      this.ch.queryScoped(
        `SELECT sum(cost_usd) AS cost_usd, sum(calls) AS calls, sum(total_tokens) AS tokens
         FROM spend_hourly_by_key
         WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
           AND toDate(hour) BETWEEN {from:Date} AND {to:Date}`,
        params,
      ),
      this.ch.queryScoped(
        // Distinct aliases — don't alias an aggregate to its own column name, or a
        // sibling aggregate over that column becomes a nested aggregate (error 184).
        `SELECT count() AS runs, sum(total_cost_usd) AS cost_total_usd, avg(total_cost_usd) AS cost_avg_usd
         FROM agent_runs FINAL
         WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
           AND toDate(started_at) BETWEEN {from:Date} AND {to:Date}`,
        params,
      ),
      this.ch.queryScoped(
        `SELECT status, count() AS runs FROM agent_runs FINAL
         WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
           AND toDate(started_at) BETWEEN {from:Date} AND {to:Date}
         GROUP BY status`,
        params,
      ),
    ]);
    return { agentId, spend: spend[0] ?? {}, runs: runs[0] ?? {}, statusMix };
  }

  /**
   * 30-day pilot report (ADR-036): a board-ready trial summary tracing spend →
   * outcomes → risk-adjusted ROI for the tenant over a window. Each section reads
   * the view it reports from and records that `source` so every figure traces
   * back to source events. ROI + unit economics use the headline confidence bar
   * (0.5). All sub-queries run concurrently.
   */
  async pilotReport(from?: string, to?: string): Promise<PilotReport> {
    const days = 30;
    const r = this.range(from, to, days);
    const p = r as Record<string, ChParam>;
    const HEADLINE = 0.5;

    const [spendTotals, byProvider, agents, unit, roi, severity] = await Promise.all([
      this.ch.queryScoped(
        `SELECT sum(${METERED_COST}) AS cost_usd, countIf(${METERED_COST} > 0) AS calls,
                sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                countIf(status LIKE 'blocked%') AS blocked_calls,
                countIf(status = 'upstream_error') AS error_calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE}`,
        p,
      ),
      this.ch.queryScoped(
        `SELECT provider, sum(${METERED_COST}) AS cost_usd, countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND ${LLM_CALLS_METERED_SCOPE}
         GROUP BY provider HAVING cost_usd > 0 ORDER BY cost_usd DESC`,
        p,
      ),
      this.ch.queryScoped(
        `SELECT agent_id, sum(cost_usd) AS cost_usd, sum(calls) AS calls
         FROM spend_hourly_by_key
         WHERE tenant_id = {tenant:String} AND toDate(hour) BETWEEN {from:Date} AND {to:Date} AND agent_id != ''
         GROUP BY agent_id ORDER BY cost_usd DESC LIMIT 5`,
        p,
      ),
      this.ch.queryScoped(
        `SELECT count() AS outcomes, sum(r.total_cost_usd) AS ai_cost_usd,
                sum(o.business_value_usd) AS business_value_usd,
                sum(r.total_cost_usd) / nullIf(count(), 0) AS cost_per_outcome,
                sum(o.business_value_usd) - sum(r.total_cost_usd) AS net_value_usd,
                avg(o.attribution_confidence) AS avg_confidence
         FROM agentledger.outcomes o FINAL
         LEFT JOIN agentledger.agent_runs r FINAL ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
         WHERE o.tenant_id = {tenant:String} AND toDate(o.ts) BETWEEN {from:Date} AND {to:Date}
           AND o.attribution_confidence >= {minconf:Float32}`,
        { ...p, minconf: HEADLINE },
      ),
      this.ch.queryScoped(
        `SELECT count() AS outcomes, sum(value_usd) AS value_usd,
                sum(fully_loaded_cost_usd) AS fully_loaded_cost_usd,
                sum(expected_roi_usd) AS expected_roi_usd,
                sum(risk_adjusted_roi_usd) AS risk_adjusted_roi_usd,
                sum(roi_low_usd) AS roi_low_usd, sum(roi_high_usd) AS roi_high_usd,
                avg(attribution_confidence) AS avg_confidence
         FROM agentledger.v_roi
         WHERE tenant_id = {tenant:String} AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}
           AND attribution_confidence >= {minconf:Float32}`,
        { ...p, minconf: HEADLINE },
      ),
      this.ch.queryScoped(
        // Distinct alias for the sum — aliasing it to `events` would shadow the
        // column and make the sibling sumIf()s nested aggregates (CH error 184).
        `SELECT risk_severity AS severity, sum(events) AS total_events,
                sumIf(events, dlp_action = 'block') AS dlp_block_events,
                sumIf(events, risk_severity = 'high') AS high_events
         FROM risk_daily WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY risk_severity ORDER BY total_events DESC`,
        p,
      ),
    ]);

    const st = (spendTotals[0] ?? {}) as Record<string, unknown>;
    const ue = (unit[0] ?? {}) as Record<string, unknown>;
    const ro = (roi[0] ?? {}) as Record<string, unknown>;
    const sevRows = severity as Record<string, unknown>[];

    return {
      window: { from: r.from, to: r.to, days },
      spend: {
        source: 'llm_calls (metered)',
        totalCostUsd: n(st.cost_usd),
        calls: n(st.calls),
        inputTokens: n(st.input_tokens),
        outputTokens: n(st.output_tokens),
        blockedCalls: n(st.blocked_calls),
        errorCalls: n(st.error_calls),
        byProvider: (byProvider as Record<string, unknown>[]).map((x) => ({
          provider: String(x.provider),
          costUsd: n(x.cost_usd),
          calls: n(x.calls),
        })),
      },
      topAgents: {
        source: 'spend_hourly_by_key',
        agents: (agents as Record<string, unknown>[]).map((x) => ({
          agentId: String(x.agent_id),
          costUsd: n(x.cost_usd),
          calls: n(x.calls),
        })),
      },
      unitEconomics: {
        source: 'outcomes + agent_runs',
        minConfidence: HEADLINE,
        outcomes: n(ue.outcomes),
        aiCostUsd: n(ue.ai_cost_usd),
        businessValueUsd: n(ue.business_value_usd),
        costPerOutcome: n(ue.cost_per_outcome),
        netValueUsd: n(ue.net_value_usd),
        avgConfidence: n(ue.avg_confidence),
      },
      roi: {
        source: 'v_roi',
        minConfidence: HEADLINE,
        outcomes: n(ro.outcomes),
        valueUsd: n(ro.value_usd),
        fullyLoadedCostUsd: n(ro.fully_loaded_cost_usd),
        expectedRoiUsd: n(ro.expected_roi_usd),
        riskAdjustedRoiUsd: n(ro.risk_adjusted_roi_usd),
        roiLowUsd: n(ro.roi_low_usd),
        roiHighUsd: n(ro.roi_high_usd),
        avgConfidence: n(ro.avg_confidence),
      },
      governance: {
        source: 'risk_daily',
        bySeverity: sevRows
          .filter((x) => String(x.severity) !== '')
          .map((x) => ({ severity: String(x.severity), events: n(x.total_events) })),
        dlpBlockEvents: sevRows.reduce((s, x) => s + n(x.dlp_block_events), 0),
        highSeverityEvents: sevRows.reduce((s, x) => s + n(x.high_events), 0),
      },
    };
  }

  /**
   * Compare portal CSV imports vs connector API sync by day. Queries raw llm_calls
   * because spend_daily has no source dimension — admin-only reconciliation view.
   */
  async sourceReconciliation(from?: string, to?: string): Promise<SourceReconciliationResult> {
    const r = this.range(from, to);
    const rows = await this.ch.queryScoped<{
      day: string;
      portal_cost_usd: unknown;
      portal_calls: unknown;
      api_cost_usd: unknown;
      api_calls: unknown;
    }>(
      `SELECT
         toDate(ts) AS day,
         sumIf(cost_usd, source = 'portal_import') AS portal_cost_usd,
         countIf(source = 'portal_import') AS portal_calls,
         sumIf(cost_usd, source = 'api') AS api_cost_usd,
         countIf(source = 'api') AS api_calls
       FROM agentledger.llm_calls FINAL
       WHERE tenant_id = {tenant:String}
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         AND source IN ('portal_import', 'api')
       GROUP BY day
       ORDER BY day`,
      r as Record<string, ChParam>,
    );

    const days: SourceReconciliationDay[] = rows.map((row) => ({
      day: String(row.day).slice(0, 10),
      portalCostUsd: n(row.portal_cost_usd),
      portalCalls: n(row.portal_calls),
      apiCostUsd: n(row.api_cost_usd),
      apiCalls: n(row.api_calls),
    }));

    let portalTotalUsd = 0;
    let apiTotalUsd = 0;
    let overlapDays = 0;
    let portalOnlyDays = 0;
    let apiOnlyDays = 0;
    for (const d of days) {
      portalTotalUsd += d.portalCostUsd;
      apiTotalUsd += d.apiCostUsd;
      const hasPortal = d.portalCostUsd > 0;
      const hasApi = d.apiCostUsd > 0;
      if (hasPortal && hasApi) overlapDays++;
      else if (hasPortal) portalOnlyDays++;
      else if (hasApi) apiOnlyDays++;
    }

    return {
      from: r.from,
      to: r.to,
      days,
      summary: { portalTotalUsd, apiTotalUsd, overlapDays, portalOnlyDays, apiOnlyDays },
    };
  }

  /** Member directory — token/Cursor spend (ClickHouse) + GitHub Copilot (Postgres). */
  async users(from?: string, to?: string, q?: string): Promise<UsersAnalyticsResult> {
    const r = this.range(from, to);
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const [{ totals: chTotals, breakdown: chBreakdown }, copilotPack] = await Promise.all([
      this.fetchUserSpendFromCh(r),
      this.fetchCopilotUserSpend(tenantId, r),
    ]);
    const users = await this.assembleUserDirectory(
      tenantId,
      [...chTotals, ...copilotPack.totals],
      [...chBreakdown, ...copilotPack.breakdown],
      q,
      copilotPack.hints,
    );
    return {
      from: r.from,
      to: r.to,
      users,
      sources: {
        llm_call_users: chTotals.length,
        copilot_members: copilotPack.totals.length,
      },
    };
  }

  /** Single-user drill-down for /users/[userId]. */
  async userDetail(userId: string, from?: string, to?: string): Promise<UserDirectoryRow | null> {
    if (!userId) {
      throw new BadRequestException('userId required');
    }
    const r = this.range(from, to);
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const params: Record<string, ChParam> = { ...r, userId };
    const userFilter = `AND user_id = {userId:String}`;
    const [{ totals: chTotals, breakdown: chBreakdown }, copilotPack] = await Promise.all([
      Promise.all([
        this.ch.queryScoped<{ user_id: string; total_spend_usd: unknown; calls: unknown }>(
          `SELECT user_id,
                  sum(${METERED_COST}) AS total_spend_usd,
                  countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           ${this.userSpendExclude()} AND ${LLM_CALLS_METERED_SCOPE} ${userFilter}
         GROUP BY user_id
         HAVING total_spend_usd > 0`,
          params,
        ),
        this.ch.queryScoped<{ user_id: string; platform: string; model: string; spend_usd: unknown; calls: unknown }>(
          `SELECT user_id,
                  provider AS platform,
                  if(response_model != '', response_model, request_model) AS model,
                  sum(${METERED_COST}) AS spend_usd,
                  countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           ${this.userSpendExclude()} AND ${LLM_CALLS_METERED_SCOPE} ${userFilter}
         GROUP BY user_id, provider, model
         HAVING calls > 0
         ORDER BY spend_usd DESC`,
          params,
        ),
      ]).then(([totals, breakdown]) => ({ totals, breakdown })),
      this.fetchCopilotUserSpend(tenantId, r, userId),
    ]);
    const rows = await this.assembleUserDirectory(
      tenantId,
      [...chTotals, ...copilotPack.totals],
      [...chBreakdown, ...copilotPack.breakdown],
      undefined,
      copilotPack.hints,
    );
    return rows[0] ?? null;
  }

  private userSpendExclude(): string {
    return `AND user_id != '' AND user_id != 'Unassigned'`;
  }

  private async fetchUserSpendFromCh(r: Range) {
    const params = r as Record<string, ChParam>;
    const exclude = `${this.userSpendExclude()} AND ${LLM_CALLS_METERED_SCOPE}`;
    const [totals, breakdown] = await Promise.all([
      this.ch.queryScoped<{ user_id: string; total_spend_usd: unknown; calls: unknown }>(
        `SELECT user_id,
                sum(${METERED_COST}) AS total_spend_usd,
                countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date} ${exclude}
         GROUP BY user_id
         HAVING calls > 0
         ORDER BY total_spend_usd DESC`,
        params,
      ),
      this.ch.queryScoped<{ user_id: string; platform: string; model: string; spend_usd: unknown; calls: unknown }>(
        `SELECT user_id,
                provider AS platform,
                if(response_model != '', response_model, request_model) AS model,
                sum(${METERED_COST}) AS spend_usd,
                countIf(${METERED_COST} > 0) AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String} AND toDate(ts) BETWEEN {from:Date} AND {to:Date} ${exclude}
         GROUP BY user_id, provider, model
         HAVING calls > 0
         ORDER BY user_id, spend_usd DESC`,
        params,
      ),
    ]);
    return { totals, breakdown };
  }

  /** GitHub Copilot allocated member spend (Postgres) — not in llm_calls metered rollups. */
  private async fetchCopilotUserSpend(
    tenantId: string,
    r: Range,
    githubLogin?: string,
  ): Promise<{
    totals: { user_id: string; total_spend_usd: unknown; calls: unknown }[];
    breakdown: { user_id: string; platform: string; model: string; spend_usd: unknown; calls: unknown }[];
    hints: Map<string, CopilotIdentityHint>;
  }> {
    const resp: CopilotMemberSpendResponse = await this.copilotMemberSpend.getMemberSpend(tenantId, {
      from: r.from,
      to: r.to,
      ...(githubLogin ? { user: githubLogin } : {}),
    });
    const hints = new Map<string, CopilotIdentityHint>();
    if (!resp.connected) {
      return { totals: [], breakdown: [], hints };
    }

    const totals: { user_id: string; total_spend_usd: unknown; calls: unknown }[] = [];
    const breakdown: { user_id: string; platform: string; model: string; spend_usd: unknown; calls: unknown }[] = [];

    for (const m of resp.members) {
      if (m.totalAllocatedCost <= 0) continue;
      const calls = m.chatTurns + m.linesAccepted + m.prSummaryCount;
      totals.push({
        user_id: m.githubLogin,
        total_spend_usd: m.totalAllocatedCost,
        calls,
      });
      breakdown.push({
        user_id: m.githubLogin,
        platform: 'github_copilot',
        model: 'Copilot',
        spend_usd: m.totalAllocatedCost,
        calls,
      });
      hints.set(m.githubLogin, {
        displayName: m.displayName,
        email: null,
        team: m.teamName || '',
      });
    }
    return { totals, breakdown, hints };
  }

  private async assembleUserDirectory(
    tenantId: string,
    totals: { user_id: string; total_spend_usd: unknown; calls: unknown }[],
    breakdown: { user_id: string; platform: string; model: string; spend_usd: unknown; calls: unknown }[],
    q?: string,
    copilotHints: Map<string, CopilotIdentityHint> = new Map(),
  ): Promise<UserDirectoryRow[]> {
    const totalsByUser = new Map<string, { total_spend_usd: number; calls: number }>();
    for (const row of totals) {
      totalsByUser.set(String(row.user_id), {
        total_spend_usd: usd(n(row.total_spend_usd)),
        calls: n(row.calls),
      });
    }

    const breakdownByUser = new Map<string, UserModelBreakdownRow[]>();
    for (const row of breakdown) {
      const uid = String(row.user_id);
      const list = breakdownByUser.get(uid) ?? [];
      list.push({
        model: String(row.model),
        platform: String(row.platform),
        spend_usd: usd(n(row.spend_usd)),
        calls: n(row.calls),
      });
      breakdownByUser.set(uid, list);
    }
    for (const list of breakdownByUser.values()) {
      list.sort((a, b) => b.spend_usd - a.spend_usd);
    }

    const allUserIds = new Set([...totalsByUser.keys(), ...breakdownByUser.keys()]);
    const { byId, byEmail, byAlias } = await loadIdentityLookups(this.prisma, tenantId);
    const needle = q?.trim().toLowerCase() ?? '';

    const merged = new Map<string, UserDirectoryRow>();
    for (const user_id of allUserIds) {
      const totalsRow = totalsByUser.get(user_id) ?? { total_spend_usd: 0, calls: 0 };
      const total_spend_usd = totalsRow.total_spend_usd;
      const calls = totalsRow.calls;
      if (total_spend_usd <= 0 && calls <= 0) continue;

      const identity = resolveUserDirectoryIdentity(user_id, byId, byEmail, byAlias);
      const hint = copilotHints.get(user_id);
      const display_name =
        identity.resolved
          ? identity.display_name
          : hint?.displayName?.trim() || identity.display_name;
      const email = identity.email ?? hint?.email ?? null;
      const team = identity.team || hint?.team || '';

      const model_breakdown = breakdownByUser.get(user_id) ?? [];
      const models = model_breakdown.map((m) => m.model).filter((m, i, arr) => arr.indexOf(m) === i);

      const entry: UserDirectoryRow = {
        user_id,
        display_name,
        email,
        team,
        resolved: identity.resolved,
        total_spend_usd,
        calls,
        models,
        model_breakdown,
      };
      if (needle && !this.userMatchesQuery(entry, needle)) continue;

      const key = this.canonicalUserKey(user_id, identity);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, entry);
        continue;
      }
      merged.set(key, this.mergeUserDirectoryRows(existing, entry));
    }

    return [...merged.values()].sort((a, b) => b.total_spend_usd - a.total_spend_usd);
  }

  private canonicalUserKey(user_id: string, identity: UserDirectoryIdentity): string {
    if (identity.email) return `email:${identity.email.toLowerCase()}`;
    if (isEmailLike(user_id)) return `email:${user_id.trim().toLowerCase()}`;
    return `raw:${user_id.toLowerCase()}`;
  }

  private mergeUserDirectoryRows(a: UserDirectoryRow, b: UserDirectoryRow): UserDirectoryRow {
    const primary = a.total_spend_usd >= b.total_spend_usd ? a : b;
    const secondary = primary === a ? b : a;
    const resolved = a.resolved ? a : b.resolved ? b : primary;

    const breakdownMap = new Map<string, UserModelBreakdownRow>();
    for (const row of [...a.model_breakdown, ...b.model_breakdown]) {
      const key = `${row.platform}::${row.model}`;
      const existing = breakdownMap.get(key);
      if (existing) {
        existing.spend_usd = usd(existing.spend_usd + row.spend_usd);
        existing.calls += row.calls;
      } else {
        breakdownMap.set(key, { ...row });
      }
    }
    const model_breakdown = [...breakdownMap.values()].sort((x, y) => y.spend_usd - x.spend_usd);
    const models = model_breakdown.map((m) => m.model).filter((m, i, arr) => arr.indexOf(m) === i);

    return {
      user_id: primary.user_id,
      display_name: resolved.display_name,
      email: resolved.email ?? primary.email ?? secondary.email,
      team: resolved.team || primary.team || secondary.team,
      resolved: a.resolved || b.resolved,
      total_spend_usd: usd(a.total_spend_usd + b.total_spend_usd),
      calls: a.calls + b.calls,
      models,
      model_breakdown,
    };
  }

  private userMatchesQuery(user: UserDirectoryRow, needle: string): boolean {
    const fields = [user.display_name, user.email, user.team, user.user_id];
    return fields.some((f) => f && f.toLowerCase().includes(needle));
  }
}

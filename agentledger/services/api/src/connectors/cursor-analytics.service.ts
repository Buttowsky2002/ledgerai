import { Injectable } from '@nestjs/common';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { EFFECTIVE_METERED_COST_USD } from './metered-cost';

export const CURSOR_ANALYTICS_PLATFORM = 'cursor';

const METERED_COST = EFFECTIVE_METERED_COST_USD;

/** Token volume for Cursor / llm_calls rows (input + output + cache). */
const TOKEN_SUM = `(llm_calls.input_tokens + llm_calls.output_tokens + llm_calls.cache_read_tokens + llm_calls.cache_write_tokens)`;

export interface CursorModelMixRow {
  model: string;
  billed_usd: number;
  usage_value_usd: number;
  calls: number;
}

export interface CursorDailySpend {
  day: string;
  cost_usd: number;
  calls: number;
}

export interface CursorUserSpendRow {
  user_id: string;
  total_spend_usd: number;
  calls: number;
}

/** Per-user Cursor activity: on-demand (invoice) + included usage value (not invoice). */
export interface CursorUserActivityRow {
  user_id: string;
  on_demand_usd: number;
  usage_value_usd: number;
  calls: number;
  included_calls: number;
  on_demand_calls: number;
  tokens: number;
}

export interface CursorUserBreakdownRow {
  user_id: string;
  model: string;
  spend_usd: number;
  calls: number;
}

export interface CursorUserActivityBreakdownRow {
  user_id: string;
  model: string;
  on_demand_usd: number;
  usage_value_usd: number;
  calls: number;
  on_demand_calls: number;
}

export interface CursorUserDailySpendRow {
  user_id: string;
  day: string;
  cost_usd: number;
}

/** Per-user daily Cursor activity for trends (metered overage + included usage value). */
export interface CursorUserDailyActivityRow {
  user_id: string;
  day: string;
  /** On-demand billed USD (also in metered llm_calls rollups). */
  on_demand_usd: number;
  /** Included usage value only — for trend when metered is $0. */
  included_usd: number;
  tokens: number;
  calls: number;
}

export interface CursorSpendSummary {
  billedUsd: number;
  /** On-demand overage only — alias of billedUsd for clarity in UI. */
  meteredOverageUsd: number;
  usageValueUsd: number;
  /** Prorated seat/subscription license cost for the selected range (not from usage events). */
  seatLicenseUsd: number;
  seatCount: number;
  seatUnitUsdPerMonth: number;
  seatSource: 'fixed_costs' | 'subscription_plan' | 'none';
  activeMembersInRange: number;
  totalCalls: number;
  includedCalls: number;
  onDemandCalls: number;
  /** Sum of input + output + cache read/write tokens across all Cursor events. */
  totalTokens: number;
  /** True when rows predate billing_kind tagging (operation_name != cursor:*). */
  legacyUntagged: boolean;
  daily: CursorDailySpend[];
  modelMix: CursorModelMixRow[];
  platform: { platform: string; cost_usd: number; calls: number };
  disclaimer: string;
  /** Editor accepted AI lines (Admin daily-usage-data). */
  linesAccepted?: number;
  /** Editor total lines added (not git commits). */
  linesAdded?: number;
  /** Committed AI lines from Enterprise commit attribution when available. */
  linesCommittedAi?: number;
  /** AI share of committed code (Enterprise); 0 when unavailable. */
  aiSharePct?: number;
  commitCount?: number;
  productivityDisclaimer?: string;
}

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

@Injectable()
export class CursorAnalyticsService {
  constructor(private readonly ch: AnalyticsStore) {}

  /** Invoice-grade on-demand overage by day (excludes subscription-included usage value). */
  async getDailyBilledSpend(tenantId: string, from: string, to: string): Promise<CursorDailySpend[]> {
    const rows = await this.ch.queryScoped<{ day: string; cost_usd: unknown; calls: unknown }>(
      `SELECT
         toDate(ts) AS day,
         sum(${METERED_COST}) AS cost_usd,
         countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
       GROUP BY day
       ORDER BY day`,
      { tenant: tenantId, from, to },
    );
    return rows.map((row) => ({
      day: String(row.day).slice(0, 10),
      cost_usd: usd(Number(row.cost_usd ?? 0)),
      calls: Number(row.calls ?? 0),
    }));
  }

  /** Per-user on-demand overage (billed only) for member directory and allocation. */
  async getUserBilledSpend(
    tenantId: string,
    from: string,
    to: string,
    userId?: string,
  ): Promise<CursorUserSpendRow[]> {
    const activity = await this.getUserActivity(tenantId, from, to, userId);
    return activity
      .filter((row) => row.on_demand_usd > 0 || row.on_demand_calls > 0)
      .map((row) => ({
        user_id: row.user_id,
        total_spend_usd: row.on_demand_usd,
        calls: row.on_demand_calls,
      }));
  }

  /**
   * Per-user Cursor activity including subscription-included usage value.
   * Included USD is informational only — never add it to metered / invoice totals.
   */
  async getUserActivity(
    tenantId: string,
    from: string,
    to: string,
    userId?: string,
  ): Promise<CursorUserActivityRow[]> {
    const params: Record<string, string> = { tenant: tenantId, from, to };
    let userFilter = '';
    if (userId) {
      params.userId = userId;
      userFilter = 'AND user_id = {userId:String}';
    }
    const rows = await this.ch.queryScoped<{
      user_id: string;
      on_demand_usd: unknown;
      usage_value_usd: unknown;
      calls: unknown;
      included_calls: unknown;
      on_demand_calls: unknown;
      tokens: unknown;
    }>(
      `SELECT
         user_id,
         sum(${METERED_COST}) AS on_demand_usd,
         sumIf(
           if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
           operation_name = 'cursor:included'
         ) AS usage_value_usd,
         count() AS calls,
         countIf(operation_name = 'cursor:included') AS included_calls,
         countIf(operation_name = 'cursor:on_demand' OR ${METERED_COST} > 0) AS on_demand_calls,
         sum(${TOKEN_SUM}) AS tokens
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         ${userFilter}
       GROUP BY user_id
       ORDER BY on_demand_usd DESC, usage_value_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      user_id: String(row.user_id),
      on_demand_usd: usd(Number(row.on_demand_usd ?? 0)),
      usage_value_usd: usd(Number(row.usage_value_usd ?? 0)),
      calls: Number(row.calls ?? 0),
      included_calls: Number(row.included_calls ?? 0),
      on_demand_calls: Number(row.on_demand_calls ?? 0),
      tokens: Number(row.tokens ?? 0),
    }));
  }

  async getUserBilledBreakdown(
    tenantId: string,
    from: string,
    to: string,
    userId?: string,
  ): Promise<CursorUserBreakdownRow[]> {
    const activity = await this.getUserActivityBreakdown(tenantId, from, to, userId);
    return activity
      .filter((row) => row.on_demand_usd > 0)
      .map((row) => ({
        user_id: row.user_id,
        model: row.model,
        spend_usd: row.on_demand_usd,
        calls: row.on_demand_calls,
      }));
  }

  async getUserActivityBreakdown(
    tenantId: string,
    from: string,
    to: string,
    userId?: string,
  ): Promise<CursorUserActivityBreakdownRow[]> {
    const params: Record<string, string> = { tenant: tenantId, from, to };
    let userFilter = '';
    if (userId) {
      params.userId = userId;
      userFilter = 'AND user_id = {userId:String}';
    }
    const rows = await this.ch.queryScoped<{
      user_id: string;
      model: string;
      on_demand_usd: unknown;
      usage_value_usd: unknown;
      calls: unknown;
      on_demand_calls: unknown;
    }>(
      `SELECT
         user_id,
         if(response_model != '', response_model, request_model) AS model,
         sum(${METERED_COST}) AS on_demand_usd,
         sumIf(
           if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
           operation_name = 'cursor:included'
         ) AS usage_value_usd,
         count() AS calls,
         countIf(operation_name = 'cursor:on_demand' OR ${METERED_COST} > 0) AS on_demand_calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         ${userFilter}
       GROUP BY user_id, model
       ORDER BY user_id, on_demand_usd DESC, usage_value_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      user_id: String(row.user_id),
      model: String(row.model || 'default'),
      on_demand_usd: usd(Number(row.on_demand_usd ?? 0)),
      usage_value_usd: usd(Number(row.usage_value_usd ?? 0)),
      calls: Number(row.calls ?? 0),
      on_demand_calls: Number(row.on_demand_calls ?? 0),
    }));
  }

  async getUserDailyBilledSpend(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<CursorUserDailySpendRow[]> {
    const rows = await this.ch.queryScoped<{ user_id: string; day: string; cost_usd: unknown }>(
      `SELECT
         user_id,
         toDate(ts) AS day,
         sum(${METERED_COST}) AS cost_usd
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
       GROUP BY user_id, day
       HAVING sum(${METERED_COST}) > 0
       ORDER BY user_id, day`,
      { tenant: tenantId, from, to },
    );
    return rows.map((row) => ({
      user_id: String(row.user_id),
      day: String(row.day).slice(0, 10),
      cost_usd: usd(Number(row.cost_usd ?? 0)),
    }));
  }

  /**
   * Per-user daily Cursor activity for spend trends.
   * Includes included usage value so included-only users still get an up/down signal.
   * Callers should add included_usd into trend series (not on_demand — that is already
   * in metered daily rollups).
   */
  async getUserDailyActivity(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<CursorUserDailyActivityRow[]> {
    const rows = await this.ch.queryScoped<{
      user_id: string;
      day: string;
      on_demand_usd: unknown;
      included_usd: unknown;
      tokens: unknown;
      calls: unknown;
    }>(
      `SELECT
         user_id,
         toDate(ts) AS day,
         sum(${METERED_COST}) AS on_demand_usd,
         sumIf(
           if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
           operation_name = 'cursor:included'
         ) AS included_usd,
         sum(${TOKEN_SUM}) AS tokens,
         count() AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
       GROUP BY user_id, day
       HAVING sum(${METERED_COST}) > 0
          OR sumIf(
               if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
               operation_name = 'cursor:included'
             ) > 0
          OR count() > 0
       ORDER BY user_id, day`,
      { tenant: tenantId, from, to },
    );
    return rows.map((row) => ({
      user_id: String(row.user_id),
      day: String(row.day).slice(0, 10),
      on_demand_usd: usd(Number(row.on_demand_usd ?? 0)),
      included_usd: usd(Number(row.included_usd ?? 0)),
      tokens: Number(row.tokens ?? 0),
      calls: Number(row.calls ?? 0),
    }));
  }

  async getSpendSummary(tenantId: string, from: string, to: string): Promise<CursorSpendSummary | null> {
    const params = { tenant: tenantId, from, to };

    const [totals, models, daily] = await Promise.all([
      this.ch.queryScoped<{
        billed_usd: unknown;
        usage_value_usd: unknown;
        legacy_usage_usd: unknown;
        calls: unknown;
        included_calls: unknown;
        on_demand_calls: unknown;
        legacy_calls: unknown;
        tokens: unknown;
      }>(
        `SELECT
           sum(${METERED_COST}) AS billed_usd,
           sumIf(
             if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
             operation_name = 'cursor:included'
           ) AS usage_value_usd,
           sumIf(
             if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
             provider = 'cursor' AND operation_name NOT LIKE 'cursor:%'
           ) AS legacy_usage_usd,
           count() AS calls,
           countIf(operation_name = 'cursor:included') AS included_calls,
           countIf(operation_name = 'cursor:on_demand') AS on_demand_calls,
           countIf(provider = 'cursor' AND operation_name NOT LIKE 'cursor:%') AS legacy_calls,
           sum(${TOKEN_SUM}) AS tokens
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND provider = 'cursor'
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}`,
        params,
      ),
      this.ch.queryScoped<{
        model: string;
        billed_usd: unknown;
        usage_value_usd: unknown;
        calls: unknown;
      }>(
        `SELECT
           if(response_model != '', response_model, request_model) AS model,
           sum(${METERED_COST}) AS billed_usd,
           sumIf(
             if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd),
             operation_name = 'cursor:included'
           ) AS usage_value_usd,
           count() AS calls
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND provider = 'cursor'
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         GROUP BY model
         ORDER BY usage_value_usd DESC`,
        params,
      ),
      this.getDailyBilledSpend(tenantId, from, to),
    ]);

    const row = totals[0];
    if (!row) {return null;}

    const legacyUntagged = Number(row.legacy_calls ?? 0) > 0;
    const billedUsd = usd(Number(row.billed_usd ?? 0));
    // Included-only — never fold on-demand or legacy untagged into this figure.
    const usageValueUsd = usd(Number(row.usage_value_usd ?? 0));
    const legacyUsageUsd = usd(Number(row.legacy_usage_usd ?? 0));
    const totalCalls = Number(row.calls ?? 0);
    if (totalCalls <= 0 && billedUsd <= 0 && usageValueUsd <= 0 && legacyUsageUsd <= 0) {return null;}

    const modelMix: CursorModelMixRow[] = models.map((m) => ({
      model: String(m.model || 'default'),
      billed_usd: usd(Number(m.billed_usd ?? 0)),
      usage_value_usd: usd(Number(m.usage_value_usd ?? 0)),
      calls: Number(m.calls ?? 0),
    }));

    const disclaimer = legacyUntagged
      ? `Some Cursor rows predate billing-kind tagging (${Number(row.legacy_calls ?? 0)} events, $${legacyUsageUsd.toFixed(2)} untagged usage). Re-sync the Cursor connector to split included usage value from on-demand overage. Untagged amounts are not counted as included or metered until re-synced.`
      : 'Billed overage uses on-demand events only (Cursor Admin API chargedCents). Usage value includes subscription-included requests at attributed cost — not additional invoice lines. Seat license fees come from Fixed overhead or Subscription plans — not from usage events.';

    return {
      billedUsd,
      meteredOverageUsd: billedUsd,
      usageValueUsd,
      seatLicenseUsd: 0,
      seatCount: 0,
      seatUnitUsdPerMonth: 0,
      seatSource: 'none',
      activeMembersInRange: 0,
      totalCalls,
      includedCalls: Number(row.included_calls ?? 0),
      onDemandCalls: Number(row.on_demand_calls ?? 0),
      totalTokens: Number(row.tokens ?? 0),
      legacyUntagged,
      daily,
      modelMix,
      platform: { platform: CURSOR_ANALYTICS_PLATFORM, cost_usd: billedUsd, calls: totalCalls },
      disclaimer,
    };
  }
}

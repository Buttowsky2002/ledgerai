import { Injectable } from '@nestjs/common';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { EFFECTIVE_METERED_COST_USD } from './metered-cost';

export const CURSOR_ANALYTICS_PLATFORM = 'cursor';

const METERED_COST = EFFECTIVE_METERED_COST_USD;

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

export interface CursorUserBreakdownRow {
  user_id: string;
  model: string;
  spend_usd: number;
  calls: number;
}

export interface CursorUserDailySpendRow {
  user_id: string;
  day: string;
  cost_usd: number;
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
  /** True when rows predate billing_kind tagging (operation_name != cursor:*). */
  legacyUntagged: boolean;
  daily: CursorDailySpend[];
  modelMix: CursorModelMixRow[];
  platform: { platform: string; cost_usd: number; calls: number };
  disclaimer: string;
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
    const params: Record<string, string> = { tenant: tenantId, from, to };
    let userFilter = '';
    if (userId) {
      params.userId = userId;
      userFilter = 'AND user_id = {userId:String}';
    }
    const rows = await this.ch.queryScoped<{ user_id: string; total_spend_usd: unknown; calls: unknown }>(
      `SELECT
         user_id,
         sum(${METERED_COST}) AS total_spend_usd,
         countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         ${userFilter}
       GROUP BY user_id
       HAVING calls > 0
       ORDER BY total_spend_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      user_id: String(row.user_id),
      total_spend_usd: usd(Number(row.total_spend_usd ?? 0)),
      calls: Number(row.calls ?? 0),
    }));
  }

  async getUserBilledBreakdown(
    tenantId: string,
    from: string,
    to: string,
    userId?: string,
  ): Promise<CursorUserBreakdownRow[]> {
    const params: Record<string, string> = { tenant: tenantId, from, to };
    let userFilter = '';
    if (userId) {
      params.userId = userId;
      userFilter = 'AND user_id = {userId:String}';
    }
    const rows = await this.ch.queryScoped<{
      user_id: string;
      model: string;
      spend_usd: unknown;
      calls: unknown;
    }>(
      `SELECT
         user_id,
         if(response_model != '', response_model, request_model) AS model,
         sum(${METERED_COST}) AS spend_usd,
         countIf(${METERED_COST} > 0) AS calls
       FROM llm_calls
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND user_id != ''
         AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
         ${userFilter}
       GROUP BY user_id, model
       HAVING calls > 0
       ORDER BY user_id, spend_usd DESC`,
      params,
    );
    return rows.map((row) => ({
      user_id: String(row.user_id),
      model: String(row.model || 'default'),
      spend_usd: usd(Number(row.spend_usd ?? 0)),
      calls: Number(row.calls ?? 0),
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

  async getSpendSummary(tenantId: string, from: string, to: string): Promise<CursorSpendSummary | null> {
    const params = { tenant: tenantId, from, to };

    const [totals, models, daily] = await Promise.all([
      this.ch.queryScoped<{
        billed_usd: unknown;
        usage_value_usd: unknown;
        calls: unknown;
        included_calls: unknown;
        on_demand_calls: unknown;
        legacy_calls: unknown;
      }>(
        `SELECT
           sum(${METERED_COST}) AS billed_usd,
           sum(if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd)) AS usage_value_usd,
           count() AS calls,
           countIf(operation_name = 'cursor:included') AS included_calls,
           countIf(operation_name = 'cursor:on_demand') AS on_demand_calls,
           countIf(provider = 'cursor' AND operation_name NOT LIKE 'cursor:%') AS legacy_calls
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
           sum(if(llm_calls.usage_value_usd > 0, llm_calls.usage_value_usd, llm_calls.cost_usd)) AS usage_value_usd,
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
    if (!row) return null;

    const legacyUntagged = Number(row.legacy_calls ?? 0) > 0;
    const billedUsd = usd(Number(row.billed_usd ?? 0));
    const usageValueUsd = usd(Number(row.usage_value_usd ?? 0));
    const totalCalls = Number(row.calls ?? 0);
    if (totalCalls <= 0 && billedUsd <= 0 && usageValueUsd <= 0) return null;

    const modelMix: CursorModelMixRow[] = models.map((m) => ({
      model: String(m.model || 'default'),
      billed_usd: usd(Number(m.billed_usd ?? 0)),
      usage_value_usd: usd(Number(m.usage_value_usd ?? 0)),
      calls: Number(m.calls ?? 0),
    }));

    const disclaimer = legacyUntagged
      ? 'Some Cursor rows predate billing-kind tagging. Re-sync the Cursor connector to split included usage value from on-demand overage. Until then, usage value may equal legacy cost_usd totals.'
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
      legacyUntagged,
      daily,
      modelMix,
      platform: { platform: CURSOR_ANALYTICS_PLATFORM, cost_usd: billedUsd, calls: totalCalls },
      disclaimer,
    };
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam, ClickHouseService } from '../clickhouse/clickhouse.service';

/** Coerce a ClickHouse scalar (numbers can arrive as strings) to a number. */
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export interface AgentRoiSummary {
  cost_usd: number;
  value_usd: number;
  net_value_usd: number;
  outcomes_count: number;
  cost_per_success: number | null;
  attribution_confidence_avg: number;
  risk_adjusted_roi: number;
}

export interface AgentRoiResponse {
  agentId: string;
  from: string;
  to: string;
  summary: AgentRoiSummary;
  /** Per-day unit economics from v_agent_daily_unit_economics. */
  daily: Record<string, unknown>[];
}

/**
 * Per-agent ROI for GET /v1/agents/:id/roi. Reads the finance-grade v_roi engine
 * (and its v_agent_daily_unit_economics rollup, migration 010) scoped to one
 * agent. Tenant isolation is enforced by ClickHouseService.queryScoped, which
 * binds `tenant_id = {tenant:String}` from the request principal — the agent id
 * is a bound parameter, never interpolated (security rules 3 + 4).
 */
@Injectable()
export class AgentRoiService {
  constructor(private readonly ch: ClickHouseService) {}

  /** Resolve an optional ISO-date range, defaulting to the last `days` days. */
  private range(from?: string, to?: string, days = 365): { from: string; to: string } {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  async agentRoi(agentId: string, from?: string, to?: string): Promise<AgentRoiResponse> {
    if (!agentId) {
      throw new BadRequestException('agent id required');
    }
    const r = this.range(from, to);
    const params: Record<string, ChParam> = { ...r, agent: agentId };

    const [summaryRows, daily] = await Promise.all([
      // Exact range summary straight from v_roi so cost_per_success and the
      // confidence mean are computed over individual outcomes, not day rollups.
      // Aggregate in an inner query, then do the arithmetic outside it — reusing
      // an aggregate alias inside another aggregate (sum(value_usd) for both
      // value_usd and net) is a nested aggregate (ClickHouse error 184).
      this.ch.queryScoped(
        `SELECT
           cost_usd,
           value_usd,
           value_usd - fully_loaded_cost_usd                AS net_value_usd,
           outcomes_count,
           fully_loaded_cost_usd / nullIf(success_count, 0) AS cost_per_success,
           attribution_confidence_avg,
           risk_adjusted_roi
         FROM
         (
           SELECT
             sum(ai_cost_usd)            AS cost_usd,
             sum(value_usd)              AS value_usd,
             sum(fully_loaded_cost_usd)  AS fully_loaded_cost_usd,
             count()                     AS outcomes_count,
             countIf(headline_eligible)  AS success_count,
             avg(attribution_confidence) AS attribution_confidence_avg,
             sum(risk_adjusted_roi_usd)  AS risk_adjusted_roi
           FROM agentledger.v_roi
           WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
             AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}
         )`,
        params,
      ),
      this.ch.queryScoped(
        `SELECT day, cost_usd, outcomes_count, value_usd, net_value_usd,
                cost_per_success, attribution_confidence_avg, risk_adjusted_roi
         FROM agentledger.v_agent_daily_unit_economics
         WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
           AND day BETWEEN {from:Date} AND {to:Date}
         ORDER BY day`,
        params,
      ),
    ]);

    const s = (summaryRows[0] ?? {}) as Record<string, unknown>;
    const cps = s.cost_per_success;
    const summary: AgentRoiSummary = {
      cost_usd: n(s.cost_usd),
      value_usd: n(s.value_usd),
      net_value_usd: n(s.net_value_usd),
      outcomes_count: n(s.outcomes_count),
      cost_per_success: cps === null || cps === undefined ? null : n(cps),
      attribution_confidence_avg: n(s.attribution_confidence_avg),
      risk_adjusted_roi: n(s.risk_adjusted_roi),
    };

    return { agentId, from: r.from, to: r.to, summary, daily };
  }
}

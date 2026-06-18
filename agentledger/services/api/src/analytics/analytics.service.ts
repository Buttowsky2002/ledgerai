import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam, ClickHouseService } from '../clickhouse/clickhouse.service';

type Range = { from: string; to: string };

/**
 * Read-only analytics over the ClickHouse materialized views — NEVER raw
 * llm_calls (spec §3). Every query goes through ClickHouseService.queryScoped, so
 * `tenant_id = {tenant:String}` is bound from the JWT principal (the sole tenant
 * isolation mechanism in ClickHouse). All other inputs are bound parameters too.
 * MVs are SummingMergeTree, so queries re-aggregate with sum()/GROUP BY.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly ch: ClickHouseService) {}

  /** Resolve an optional ISO-date range, defaulting to the last `days` days. */
  private range(from: string | undefined, to: string | undefined, days = 30): Range {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  spend(from?: string, to?: string) {
    const r = this.range(from, to);
    // Select `day` directly (don't alias an expression to the column name — that
    // shadows it and breaks the BETWEEN in WHERE). ClickHouse renders Date as
    // 'YYYY-MM-DD' in JSON.
    return this.ch.queryScoped(
      `SELECT day, sum(cost_usd) AS cost_usd, sum(calls) AS calls,
              sum(input_tokens + output_tokens) AS tokens,
              sum(blocked_calls) AS blocked_calls, sum(error_calls) AS error_calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY day ORDER BY day`,
      r as Record<string, ChParam>,
    );
  }

  allocation(dimension: 'team' | 'app' | 'agent', from?: string, to?: string) {
    const r = this.range(from, to);
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
      `SELECT ${col} AS key, sum(cost_usd) AS cost_usd, sum(calls) AS calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY ${col} ORDER BY cost_usd DESC`,
      r as Record<string, ChParam>,
    );
    // NOTE: `col` is a fixed identifier from a validated enum (never user text),
    // so this is not dynamic SQL from input; all values remain bound parameters.
  }

  modelMix(from?: string, to?: string) {
    const r = this.range(from, to);
    return this.ch.queryScoped(
      `SELECT provider, model, sum(cost_usd) AS cost_usd, sum(calls) AS calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY provider, model ORDER BY cost_usd DESC`,
      r as Record<string, ChParam>,
    );
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

  risk(from?: string, to?: string) {
    const r = this.range(from, to);
    return this.ch.queryScoped(
      `SELECT day, dlp_action, risk_severity, sum(events) AS events
       FROM risk_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY day, dlp_action, risk_severity ORDER BY day`,
      r as Record<string, ChParam>,
    );
  }

  // Cost per outcome, filtered by attribution confidence. Queries the base
  // outcomes/agent_runs tables (NOT v_unit_economics) so a per-outcome
  // confidence threshold can exclude rows BEFORE aggregation — the headline
  // cost_per_outcome ratio stays correct. FINAL collapses the attribution
  // matcher's re-inserted rows (same approach as agentDetail's agent_runs FINAL).
  // minConfidence defaults to 0 (include all, incl. unattributed outcomes).
  unitEconomics(from?: string, to?: string, outcomeType?: string, minConfidence = 0) {
    const r = this.range(from, to, 365);
    const filter = outcomeType ? 'AND o.outcome_type = {otype:String}' : '';
    const params: Record<string, ChParam> = { ...r, minconf: minConfidence };
    if (outcomeType) {
      params.otype = outcomeType;
    }
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
         AND o.attribution_confidence >= {minconf:Float32} ${filter}
       GROUP BY month, outcome_type, team_id ORDER BY month`,
      params,
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
}

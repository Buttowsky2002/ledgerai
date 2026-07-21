import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';

export interface RunDetail {
  run: Record<string, unknown>;
  /** Outcomes attributed to this run (the value side of the evidence chain). */
  outcomes: Record<string, unknown>[];
  /** Tool/MCP calls observed during the run (governance side). */
  toolCalls: Record<string, unknown>[];
}

/**
 * Single-run detail for GET /v1/runs/:id — the run node of the Outcome Graph
 * evidence chain (cost → run → outcome). Reads ClickHouse via queryScoped, so
 * `tenant_id = {tenant:String}` is bound from the principal and the run id is a
 * bound parameter (security rules 3 + 4). FINAL collapses ReplacingMergeTree
 * re-inserts (the attribution matcher re-stamps outcome rows).
 */
@Injectable()
export class RunsService {
  constructor(private readonly ch: AnalyticsStore) {}

  async get(runId: string): Promise<RunDetail> {
    if (!runId) {
      throw new BadRequestException('run id required');
    }
    const params: Record<string, ChParam> = { run: runId };

    const runs = await this.ch.queryScoped(
      `SELECT run_id, agent_id, app_id, user_id, started_at, ended_at, status,
              total_cost_usd, total_tokens, llm_calls, tool_calls, risk_events,
              objective, outcome_id
       FROM agentledger.agent_runs FINAL
       WHERE tenant_id = {tenant:String} AND run_id = {run:String}
       LIMIT 1`,
      params,
    );
    if (runs.length === 0) {
      throw new NotFoundException(`run ${runId} not found`);
    }

    const [outcomes, toolCalls] = await Promise.all([
      this.ch.queryScoped(
        `SELECT outcome_id, outcome_type, source_system AS source, ts AS occurred_at,
                business_value_usd AS value_usd, attribution_confidence AS confidence,
                completion_status, team_id, user_id
         FROM agentledger.outcomes FINAL
         WHERE tenant_id = {tenant:String} AND run_id = {run:String}
         ORDER BY ts`,
        params,
      ),
      this.ch.queryScoped(
        `SELECT tool_call_id, tool_name, mcp_server, ts
         FROM agentledger.agent_tool_calls FINAL
         WHERE tenant_id = {tenant:String} AND run_id = {run:String}
         ORDER BY ts`,
        params,
      ),
    ]);

    return { run: runs[0], outcomes, toolCalls };
  }
}

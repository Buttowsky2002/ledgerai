import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ChParam, ClickHouseService } from '../clickhouse/clickhouse.service';
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

/** Coerce a ClickHouse scalar (numbers may arrive as strings) to a number. */
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

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
    private readonly ch: ClickHouseService,
    private readonly prisma: PrismaService,
    private readonly lari: LariService,
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
    // Select `day` directly (don't alias an expression to the column name — that
    // shadows it and breaks the BETWEEN in WHERE). ClickHouse renders Date as
    // 'YYYY-MM-DD' in JSON.
    return this.ch.queryScoped(
      `SELECT day, sum(cost_usd) AS cost_usd, sum(calls) AS calls,
              sum(input_tokens + output_tokens) AS tokens,
              sum(blocked_calls) AS blocked_calls, sum(error_calls) AS error_calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date} ${tf}
       GROUP BY day ORDER BY day`,
      params,
    );
  }

  allocation(dimension: 'team' | 'app' | 'agent' | 'user', from?: string, to?: string) {
    const r = this.range(from, to);
    if (dimension === 'user') {
      return this.ch.queryScoped(
        `SELECT if(user_id = '', 'Unassigned', user_id) AS key,
                sum(cost_usd) AS cost_usd, sum(calls) AS calls
         FROM spend_daily_by_user
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY key ORDER BY cost_usd DESC`,
        r as Record<string, ChParam>,
      );
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

  /** Spend grouped by provider/platform — powers Overview and Model Mix pie charts. */
  platformSpend(from?: string, to?: string) {
    const r = this.range(from, to);
    return this.ch.queryScoped(
      `SELECT provider AS platform, sum(cost_usd) AS cost_usd, sum(calls) AS calls
       FROM spend_daily
       WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
       GROUP BY provider ORDER BY cost_usd DESC`,
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
        `SELECT sum(cost_usd) AS cost_usd, sum(calls) AS calls,
                sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                sum(blocked_calls) AS blocked_calls, sum(error_calls) AS error_calls
         FROM spend_daily WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}`,
        p,
      ),
      this.ch.queryScoped(
        `SELECT provider, sum(cost_usd) AS cost_usd, sum(calls) AS calls
         FROM spend_daily WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY provider ORDER BY cost_usd DESC`,
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
        source: 'spend_daily',
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
}

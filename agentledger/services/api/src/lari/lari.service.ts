import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { calculateRiskAdjustedROI } from './lari';
import { AgentROIInput, AgentROIResult, OutcomeLink, RiskSeverity } from './lari.types';

/** Per-outcome financials from v_roi (the finance-grade ROI engine). */
export interface VRoiOutcomeRow {
  outcome_id: string;
  outcome_type: string;
  value_usd: number;
  qa_cost_usd: number;
  eval_cost_usd: number;
  integration_cost_usd: number;
  platform_overhead_usd: number;
  attribution_confidence: number;
  risk_exposure_pct: number;
  outcome_ts: string;
}

/** Provenance/verification per outcome (from the outcomes table). */
export interface OutcomeMetaRow {
  outcome_id: string;
  source_system: string;
  completion_status: string;
}

/** Counterfactual baseline + method per outcome (from Postgres attribution_edges). */
export interface EdgeRow {
  outcomeId: string;
  counterfactualDelta: number | null;
  attributionMethod: string;
}

export interface AssembleInputs {
  agentId: string;
  from: string;
  to: string;
  vroi: VRoiOutcomeRow[];
  meta: Map<string, OutcomeMetaRow>;
  edges: Map<string, EdgeRow>;
  /** True agent token spend over the period (spend_hourly_by_key). */
  tokenCostUsd: number;
  /** Highest governed risk-event severity for the agent in the period. */
  severity: RiskSeverity;
  riskEventCount: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/** Map an LARI severity to a default incident probability (documented heuristic). */
const SEVERITY_PROBABILITY: Record<RiskSeverity, number> = {
  none: 0,
  low: 0.05,
  medium: 0.15,
  high: 0.3,
  critical: 0.5,
};

const SEVERITY_RANK: Record<RiskSeverity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Days between two ISO dates (>= 0). */
function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms / 86_400_000) : 0;
}

/**
 * PURE assembler: maps query results into a fully-formed AgentROIInput. Kept
 * separate from I/O so the (heuristic) mapping is unit-testable. Documented
 * heuristics: token cost = real agent spend; human review + infra come from the
 * v_roi loaded-cost components; incrementality = the attribution edge's
 * counterfactual delta when present, else 1.0 (full credit — flagged as a
 * limitation by the engine); confidence sub-scores are derived from coverage of
 * deterministic evidence, baselines, verification, and recency.
 */
export function buildAgentROIInput(a: AssembleInputs): AgentROIInput {
  const outcomes: OutcomeLink[] = a.vroi.map((row) => {
    const edge = a.edges.get(row.outcome_id);
    const m = a.meta.get(row.outcome_id);
    const hasBaseline = edge?.counterfactualDelta !== null && edge?.counterfactualDelta !== undefined;
    const incrementalityFactor = hasBaseline ? clamp01(n(edge!.counterfactualDelta)) : 1.0;
    const method = (edge?.attributionMethod ??
      (n(row.attribution_confidence) >= 0.99 ? 'deterministic' : 'probabilistic')) as OutcomeLink['attributionMethod'];
    const sourceSystem = m?.source_system ?? '';
    const source: OutcomeLink['outcome']['source'] =
      sourceSystem === 'manual' ? 'manual' : sourceSystem === 'api' ? 'api' : method === 'deterministic' ? 'deterministic' : 'connector';
    const verified = m?.completion_status === 'completed' && source !== 'manual' && source !== 'api';
    return {
      outcome: {
        outcomeId: row.outcome_id,
        outcomeType: row.outcome_type,
        grossValueUsd: n(row.value_usd),
        source,
        verified,
        occurredAt: row.outcome_ts,
      },
      attributionConfidence: clamp01(n(row.attribution_confidence)),
      incrementalityFactor,
      attributionMethod: method,
      evidenceRefs: edge ? [`attribution_edge:${method}`] : [],
    };
  });

  const count = outcomes.length || 1;
  const humanReviewCostUsd = a.vroi.reduce((s, r) => s + n(r.qa_cost_usd), 0);
  const infraCostUsd = a.vroi.reduce(
    (s, r) => s + n(r.eval_cost_usd) + n(r.integration_cost_usd) + n(r.platform_overhead_usd),
    0,
  );
  const cost = {
    tokenCostUsd: a.tokenCostUsd,
    humanReviewCostUsd,
    infraCostUsd,
    amortizedBuildCostUsd: 0,
  };

  const riskExposurePct = a.vroi.reduce((mx, r) => Math.max(mx, clamp01(n(r.risk_exposure_pct))), 0);

  // Confidence sub-scores (documented heuristics derived from coverage).
  const withEdge = outcomes.filter((o) => o.evidenceRefs.length > 0).length;
  const deterministic = outcomes.filter((o) => o.attributionMethod === 'deterministic').length;
  const verified = outcomes.filter((o) => o.outcome.verified).length;
  const avgAttribution = outcomes.reduce((s, o) => s + o.attributionConfidence, 0) / count;
  const nonzeroCost = [cost.tokenCostUsd, cost.humanReviewCostUsd, cost.infraCostUsd, cost.amortizedBuildCostUsd].filter(
    (c) => c > 0,
  ).length;
  const latest = a.vroi.reduce((mx, r) => (r.outcome_ts > mx ? r.outcome_ts : mx), a.from);
  const recency = outcomes.length ? Math.exp(-daysBetween(latest, a.to) / 30) : 0;

  const confidence = {
    evidenceQuality: outcomes.length ? deterministic / count : 0,
    attributionStrength: outcomes.length ? avgAttribution : 0,
    causalStrength: outcomes.length ? (withEdge ? withEdge / count : 0.3) : 0,
    costCompleteness: nonzeroCost / 4,
    outcomeVerification: outcomes.length ? verified / count : 0,
    recency,
  };

  return {
    agentId: a.agentId,
    periodFrom: a.from,
    periodTo: a.to,
    outcomes,
    cost,
    risk: {
      severity: a.severity,
      riskExposurePct,
      incidentProbability: SEVERITY_PROBABILITY[a.severity],
      riskEventCount: a.riskEventCount,
    },
    confidence,
    baselineMethod: a.edges.size
      ? 'counterfactual delta from attribution edges (engine v2)'
      : 'no counterfactual baseline — full-credit incrementality (conservative)',
  };
}

/**
 * Assembles an AgentROIInput from live ClickHouse + Postgres data and runs the
 * deterministic LARI engine. Tenant isolation: every ClickHouse read goes through
 * queryScoped (tenant bound from the principal) and the Postgres read through
 * prisma.withTenant (RLS). The agent id is a bound parameter (rules 3 + 4). No raw
 * content is read at any point (rule 2 / requirement 8).
 */
@Injectable()
export class LariService {
  constructor(
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
  ) {}

  private range(from?: string, to?: string, days = 365): { from: string; to: string } {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  async computeForAgent(agentId: string, from?: string, to?: string): Promise<AgentROIResult> {
    if (!agentId) {
      throw new BadRequestException('agent id required');
    }
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const r = this.range(from, to);
    const params: Record<string, ChParam> = { ...r, agent: agentId };

    const vroi = await this.ch.queryScoped<VRoiOutcomeRow>(
      `SELECT outcome_id, outcome_type, value_usd, qa_cost_usd, eval_cost_usd,
              integration_cost_usd, platform_overhead_usd, attribution_confidence,
              risk_exposure_pct, outcome_ts
       FROM agentledger.v_roi
       WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
         AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}`,
      params,
    );
    const metaRows = await this.ch.queryScoped<OutcomeMetaRow>(
      `SELECT o.outcome_id AS outcome_id, o.source_system AS source_system,
              o.completion_status AS completion_status
       FROM agentledger.outcomes o FINAL
       INNER JOIN agentledger.agent_runs r FINAL
         ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
       WHERE o.tenant_id = {tenant:String} AND r.agent_id = {agent:String}
         AND toDate(o.ts) BETWEEN {from:Date} AND {to:Date}`,
      params,
    );
    const spendRows = await this.ch.queryScoped<{ cost_usd: number }>(
      `SELECT sum(cost_usd) AS cost_usd
       FROM agentledger.spend_hourly_by_key
       WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
         AND toDate(hour) BETWEEN {from:Date} AND {to:Date}`,
      params,
    );
    const riskRows = await this.ch.queryScoped<{ severity: string; events: number }>(
      `SELECT severity, count() AS events
       FROM agentledger.risk_events FINAL
       WHERE tenant_id = {tenant:String} AND agent_id = {agent:String}
         AND toDate(detected_at) BETWEEN {from:Date} AND {to:Date}
       GROUP BY severity`,
      params,
    );

    // attribution_edges has no Prisma model (worker-owned table) — read via raw SQL
    // inside withTenant so RLS scopes to the tenant (no tenant_id in the query),
    // mirroring AttributionService. Empty on data not yet scored by the engine.
    const edges = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<{ outcome_id: string; counterfactual_delta: number | null; attribution_method: string }[]>`
        SELECT outcome_id, counterfactual_delta, attribution_method
        FROM attribution_edges WHERE agent_id = ${agentId}`,
    );

    const meta = new Map(metaRows.map((m) => [m.outcome_id, m]));
    const edgeMap = new Map<string, EdgeRow>(
      edges.map((e) => [
        e.outcome_id,
        {
          outcomeId: e.outcome_id,
          counterfactualDelta: e.counterfactual_delta === null ? null : Number(e.counterfactual_delta),
          attributionMethod: e.attribution_method,
        },
      ]),
    );

    const severity = this.topSeverity(riskRows);
    const riskEventCount = riskRows.reduce((s, row) => s + n(row.events), 0);

    const input = buildAgentROIInput({
      agentId,
      from: r.from,
      to: r.to,
      vroi,
      meta,
      edges: edgeMap,
      tokenCostUsd: n(spendRows[0]?.cost_usd),
      severity,
      riskEventCount,
    });

    return calculateRiskAdjustedROI(input);
  }

  private topSeverity(rows: { severity: string; events: number }[]): RiskSeverity {
    let top: RiskSeverity = 'none';
    for (const row of rows) {
      const s = (['low', 'medium', 'high', 'critical'].includes(row.severity) ? row.severity : 'none') as RiskSeverity;
      if (SEVERITY_RANK[s] > SEVERITY_RANK[top]) top = s;
    }
    return top;
  }
}

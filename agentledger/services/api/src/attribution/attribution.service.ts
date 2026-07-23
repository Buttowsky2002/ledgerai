import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';

/**
 * Confidence-audit reads (build-plan sub-phase 3.7) — the moat made auditable. Any
 * attributed score traces to its evidence: the per-signal contribution breakdown,
 * the method, the model version, the counterfactual delta, and (for coalitions) the
 * Shapley split.
 *
 * The attribution tables live in Postgres (ADR-040), so every read runs inside
 * prisma.withTenant — a transaction that binds app.tenant_id, so RLS scopes the
 * result to the caller's tenant. There is NO tenant_id in the SQL: isolation is the
 * RLS policy, identical to the rest of the control plane. Read-only; the worker is
 * the only writer of these tables.
 */
@Injectable()
export class AttributionService {
  constructor(private readonly prisma: PrismaService) {}

  private tenant(): string {
    const t = getTenantId();
    if (!t) {
      throw new BadRequestException('no tenant in context');
    }
    return t;
  }

  /** Attribution edges, optionally filtered by outcome or agent, above a confidence floor. */
  edges(outcomeId?: string, agentId?: string, minConfidence = 0): Promise<AttributionEdge[]> {
    const oid = outcomeId ?? null;
    const aid = agentId ?? null;
    return this.prisma.withTenant(this.tenant(), (tx) =>
      tx.$queryRaw<AttributionEdge[]>`
        SELECT edge_id, outcome_id, run_id, agent_id, coalition_id, attribution_method,
               confidence_raw, confidence_calibrated, signal_contributions,
               counterfactual_delta, value_attributed, cost_attributed, model_version, created_at
        FROM attribution_edges
        WHERE (${oid}::text IS NULL OR outcome_id = ${oid})
          AND (${aid}::text IS NULL OR agent_id = ${aid})
          AND confidence_calibrated >= ${minConfidence}::double precision
        ORDER BY confidence_calibrated DESC, created_at DESC`,
    );
  }

  /** One multi-agent coalition's members + Shapley split. */
  async coalition(coalitionId: string): Promise<AttributionCoalition> {
    const rows = await this.prisma.withTenant(this.tenant(), (tx) =>
      tx.$queryRaw<AttributionCoalition[]>`
        SELECT coalition_id, outcome_id, members, method, sample_count, created_at
        FROM attribution_coalitions WHERE coalition_id = ${coalitionId}::uuid`,
    );
    if (!rows[0]) {
      throw new NotFoundException('coalition not found');
    }
    return rows[0];
  }

  /** Counterfactual baselines (with confounder-check caveats) for the audit trail. */
  baselines(scope?: string, subjectId?: string, outcomeType?: string): Promise<AttributionBaseline[]> {
    const sc = scope ?? null;
    const sid = subjectId ?? null;
    const ot = outcomeType ?? null;
    return this.prisma.withTenant(this.tenant(), (tx) =>
      tx.$queryRaw<AttributionBaseline[]>`
        SELECT scope, subject_id, outcome_type, baseline_rate, sample_size,
               confounder_checks, window_start, window_end, model_version, computed_at
        FROM attribution_baselines
        WHERE (${sc}::text IS NULL OR scope = ${sc})
          AND (${sid}::text IS NULL OR subject_id = ${sid})
          AND (${ot}::text IS NULL OR outcome_type = ${ot})
        ORDER BY computed_at DESC`,
    );
  }
}

export type AttributionEdge = {
  edge_id: string;
  outcome_id: string;
  run_id: string;
  agent_id: string;
  coalition_id: string | null;
  attribution_method: string;
  confidence_raw: number;
  confidence_calibrated: number;
  signal_contributions: Prisma.JsonValue;
  counterfactual_delta: number | null;
  value_attributed: number | null;
  cost_attributed: number | null;
  model_version: string;
  created_at: Date;
};

export type AttributionCoalition = {
  coalition_id: string;
  outcome_id: string;
  members: Prisma.JsonValue;
  method: string;
  sample_count: number;
  created_at: Date;
};

export type AttributionBaseline = {
  scope: string;
  subject_id: string;
  outcome_type: string;
  baseline_rate: number | null;
  sample_size: number;
  confounder_checks: Prisma.JsonValue;
  window_start: Date | null;
  window_end: Date | null;
  model_version: string | null;
  computed_at: Date;
};

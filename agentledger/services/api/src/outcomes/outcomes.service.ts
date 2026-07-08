import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';
import { CreateOutcomeDto, ListOutcomesQueryDto } from './outcomes.dto';

export interface CreatedOutcome {
  outcome_id: string;
  outcome_type: string;
  value_usd: number;
  confidence: number;
  source: string;
  run_id: string;
  occurred_at: string;
}

/**
 * Outcomes API (GET /v1/outcomes, POST /v1/outcomes) — the value side of the
 * Outcome Graph. Reads go through ClickHouseService.queryScoped (tenant bound from
 * the principal, fails closed). The write is a direct ClickHouse insert into the
 * canonical `outcomes` table (ADR-046), mirroring ImportService: ClickHouse has no
 * RLS, so tenant_id is stamped from the principal — never from the request body
 * (rule 3). There is no content field (rule 2). Each create is audited (rule 10).
 */
@Injectable()
export class OutcomesService {
  private readonly logger = new Logger(OutcomesService.name);

  constructor(
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
  ) {}

  /** Resolve an optional ISO-date range, defaulting to the last `days` days. */
  private range(from?: string, to?: string, days = 365): { from: string; to: string } {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  /** List outcomes joined to their run's AI cost (the cost→outcome row). */
  list(q: ListOutcomesQueryDto): Promise<Record<string, unknown>[]> {
    const r = this.range(q.from, q.to);
    const page = parsePagination(q.limit, q.offset);
    const params: Record<string, ChParam> = {
      ...r,
      minconf: q.minConfidence ?? 0,
      limit: page.limit,
      offset: page.offset,
    };
    const filters: string[] = [];
    if (q.outcomeType) {
      filters.push('AND o.outcome_type = {otype:String}');
      params.otype = q.outcomeType;
    }
    if (q.source) {
      filters.push('AND o.source_system = {src:String}');
      params.src = q.source;
    }
    if (q.agentId) {
      filters.push('AND r.agent_id = {agent:String}');
      params.agent = q.agentId;
    }
    return this.ch.queryScoped(
      `SELECT o.outcome_id AS outcome_id, o.outcome_type AS outcome_type,
              o.source_system AS source, o.ts AS occurred_at,
              o.business_value_usd AS value_usd, o.attribution_confidence AS confidence,
              o.completion_status AS completion_status, o.team_id AS team_id,
              o.user_id AS user_id, o.run_id AS run_id,
              r.agent_id AS agent_id, r.total_cost_usd AS cost_usd
       FROM agentledger.outcomes o FINAL
       LEFT JOIN agentledger.agent_runs r FINAL
         ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
       WHERE o.tenant_id = {tenant:String}
         AND toDate(o.ts) BETWEEN {from:Date} AND {to:Date}
         AND o.attribution_confidence >= {minconf:Float32} ${filters.join(' ')}
       ORDER BY o.ts DESC
       LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      params,
    );
  }

  /** Create one outcome (manual / API source) directly in ClickHouse. */
  async create(dto: CreateOutcomeDto): Promise<CreatedOutcome> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const outcomeId = `out_${randomUUID().replace(/-/g, '')}`;
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt).toISOString() : new Date().toISOString();
    const row = {
      outcome_id: outcomeId,
      tenant_id: tenantId,
      ts: occurredAt,
      source_system: dto.source ?? 'api',
      outcome_type: dto.outcomeType,
      team_id: dto.teamId ?? '',
      user_id: dto.userId ?? '',
      run_id: dto.runId ?? '',
      business_value_usd: dto.valueUsd,
      quality_score: dto.qualityScore ?? 0,
      attribution_confidence: dto.confidence ?? 1,
      completion_status: dto.completionStatus ?? 'completed',
    };

    // Write the row, then audit in a tenant-bound transaction. ClickHouse is not
    // enrolled in the Postgres tx, so an audit failure after a successful insert
    // leaves the outcome written but unaudited — an at-least-once edge documented
    // in ADR-046 (acceptable for a manual create; never silent data loss).
    await this.ch.insertRows('outcomes', [row]);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actor: getPrincipal()?.userId ?? 'system',
          action: 'create',
          object: `outcome:${outcomeId}`,
          detail: {
            outcome_type: row.outcome_type,
            business_value_usd: row.business_value_usd,
            run_id: row.run_id,
            source_system: row.source_system,
            attribution_confidence: row.attribution_confidence,
          },
        },
      }),
    );
    this.logger.log({ event: 'outcome_created', tenantId, outcome_id: outcomeId }, 'outcome');

    return {
      outcome_id: outcomeId,
      outcome_type: row.outcome_type,
      value_usd: row.business_value_usd,
      confidence: row.attribution_confidence,
      source: row.source_system,
      run_id: row.run_id,
      occurred_at: occurredAt,
    };
  }
}

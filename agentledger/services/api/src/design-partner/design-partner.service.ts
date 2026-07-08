import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { recordAudit } from '../common/audit';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { env } from '../env';
import { LariService } from '../lari/lari.service';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { OnboardDesignPartnerDto } from './design-partner.dto';
import {
  DesignPartnerProfile,
  LariAgentSummary,
  OnboardDesignPartnerReport,
} from './design-partner.types';

const PRESETS_DIR = join(__dirname, 'presets');
const BOOTSTRAP_RUN_PREFIX = 'bootstrap_';
const BOOTSTRAP_OUTCOME_PREFIX = 'bootstrap:';
const POLL_MS = 2000;
const POLL_MAX_MS = 30_000;

@Injectable()
export class DesignPartnerOnboardingService {
  private readonly logger = new Logger(DesignPartnerOnboardingService.name);
  private readonly presets = new Map<string, DesignPartnerProfile>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ch: AnalyticsStore,
    private readonly lari: LariService,
  ) {
    this.loadPresets();
  }

  private loadPresets(): void {
    try {
      for (const file of readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'))) {
        const id = file.replace(/\.json$/, '');
        const raw = JSON.parse(readFileSync(join(PRESETS_DIR, file), 'utf8')) as DesignPartnerProfile;
        this.presets.set(id, raw);
      }
    } catch {
      // Presets optional in test environments without compiled assets.
    }
  }

  listPresets(): string[] {
    return [...this.presets.keys()].sort();
  }

  /** One-shot design-partner demo setup: agents → runs/outcomes → attribution → LARI verify. */
  async onboard(dto: OnboardDesignPartnerDto): Promise<OnboardDesignPartnerReport> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }

    const profile = this.resolveProfile(dto);
    this.validateBootstrapIds(profile.runs, profile.outcomes);
    const clearPrior = dto.clearPrior !== false;

    let agentsRegistered = 0;
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const agent of profile.agents) {
        const existing = await tx.agent.findFirst({
          where: { tenantId, name: agent.name },
        });
        if (!existing) {
          await tx.agent.create({
            data: {
              tenantId,
              name: agent.name,
              runtimeType: agent.runtimeType ?? null,
              approvalStatus: agent.approvalStatus ?? 'approved',
              riskPosture: agent.riskPosture ?? 'unknown',
            },
          });
          agentsRegistered += 1;
        }
      }

      if (clearPrior) {
        await tx.$executeRaw`
          DELETE FROM attribution_edges WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`
          DELETE FROM attribution_baselines WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`
          DELETE FROM attribution_coalitions WHERE tenant_id = ${tenantId}::uuid`;
      }

      await recordAudit(tx, {
        action: 'create',
        object: 'design-partner:onboard',
        before: null,
        after: {
          preset: dto.preset ?? null,
          agents: profile.agents.length,
          runs: profile.runs.length,
          outcomes: profile.outcomes.length,
          presentation: profile.presentation,
        },
      });
    });

    if (clearPrior) {
      await this.clearBootstrapAnalytics(tenantId);
    }

    await this.seedAnalytics(tenantId, profile);

    const attributionTriggered = await this.triggerAttribution();
    const counts = await this.pollVerification(tenantId, profile.outcomes.length);

    const lari = await this.lariSummaries(profile);
    const ready =
      counts.outcomesStamped >= profile.outcomes.length &&
      counts.vRoiRows > 0 &&
      lari.length > 0;

    return {
      preset: dto.preset,
      agentsRegistered,
      runsSeeded: profile.runs.length,
      outcomesSeeded: profile.outcomes.length,
      outcomesStamped: counts.outcomesStamped,
      attributionEdges: counts.attributionEdges,
      vRoiRows: counts.vRoiRows,
      attributionTriggered,
      presentation: {
        from: profile.presentation.from,
        to: profile.presentation.to,
        dashboardHint: `Open the CFO view with ${profile.presentation.from} → ${profile.presentation.to}`,
      },
      lari,
      ready,
    };
  }

  private resolveProfile(dto: OnboardDesignPartnerDto): DesignPartnerProfile {
    if (dto.preset) {
      const base = this.presets.get(dto.preset);
      if (!base) {
        throw new BadRequestException(
          `unknown preset "${dto.preset}" (available: ${this.listPresets().join(', ') || 'none'})`,
        );
      }
      return this.mergePresentation(base, dto.presentation);
    }

    if (!dto.agents?.length || !dto.runs?.length || !dto.outcomes?.length) {
      throw new BadRequestException('provide preset or agents, runs, and outcomes arrays');
    }

    const presentation = this.presentationWindow(dto.presentation);
    return {
      presentation,
      agents: dto.agents,
      runs: dto.runs,
      outcomes: dto.outcomes,
      roiRates: dto.roiRates ?? [],
    };
  }

  private mergePresentation(
    base: DesignPartnerProfile,
    override?: { from?: string; to?: string },
  ): DesignPartnerProfile {
    return {
      ...base,
      presentation: {
        from: override?.from ?? base.presentation.from,
        to: override?.to ?? base.presentation.to,
      },
    };
  }

  private presentationWindow(override?: { from?: string; to?: string }): { from: string; to: string } {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 90);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return {
      from: override?.from ?? iso(start),
      to: override?.to ?? iso(today),
    };
  }

  private validateBootstrapIds(
    runs: { runId: string }[],
    outcomes: { outcomeId: string }[],
  ): void {
    for (const r of runs) {
      if (!r.runId.startsWith(BOOTSTRAP_RUN_PREFIX)) {
        throw new BadRequestException(`runId must start with "${BOOTSTRAP_RUN_PREFIX}"`);
      }
    }
    for (const o of outcomes) {
      if (!o.outcomeId.startsWith(BOOTSTRAP_OUTCOME_PREFIX)) {
        throw new BadRequestException(`outcomeId must start with "${BOOTSTRAP_OUTCOME_PREFIX}"`);
      }
    }
  }

  private async clearBootstrapAnalytics(tenantId: string): Promise<void> {
    const tables: { table: string; filter: string }[] = [
      { table: 'agent_runs', filter: "run_id LIKE 'bootstrap_%'" },
      { table: 'outcomes', filter: "outcome_id LIKE 'bootstrap:%'" },
      { table: 'outcome_evidence', filter: "outcome_id LIKE 'bootstrap:%'" },
    ];
    for (const { table, filter } of tables) {
      await this.ch.command(
        `ALTER TABLE agentledger.${table} DELETE
           WHERE tenant_id = {tenant:String} AND ${filter}
           SETTINGS mutations_sync = 2`,
        { tenant: tenantId },
      );
    }
  }

  private async seedAnalytics(tenantId: string, profile: DesignPartnerProfile): Promise<void> {
    const runRows = profile.runs.map((r) => ({
      run_id: r.runId,
      tenant_id: tenantId,
      agent_id: r.agentId,
      app_id: r.appId ?? '',
      user_id: r.userId ?? '',
      started_at: r.startedAt,
      ended_at: r.endedAt,
      status: r.status,
      objective: r.objective ?? '',
      outcome_id: r.outcomeId ?? '',
      total_cost_usd: r.totalCostUsd,
      total_tokens: r.totalTokens,
      llm_calls: r.llmCalls,
      tool_calls: r.toolCalls,
      risk_events: r.riskEvents,
    }));

    const outcomeRows = profile.outcomes.map((o) => ({
      outcome_id: o.outcomeId,
      tenant_id: tenantId,
      ts: o.ts,
      source_system: o.sourceSystem,
      outcome_type: o.outcomeType,
      team_id: o.teamId ?? '',
      user_id: o.userId ?? '',
      run_id: '',
      business_value_usd: o.businessValueUsd,
      quality_score: o.qualityScore ?? 0,
      attribution_confidence: 0,
      completion_status: o.completionStatus,
    }));

    await this.ch.insertRows('agent_runs', runRows);
    await this.ch.insertRows('outcomes', outcomeRows);

    if (profile.roiRates.length > 0) {
      const now = new Date().toISOString();
      const rateRows = profile.roiRates.map((r) => ({
        tenant_id: tenantId,
        source_system: r.sourceSystem,
        outcome_type: r.outcomeType,
        hourly_rate: r.hourlyRate ?? 0,
        baseline_minutes: r.baselineMinutes ?? 0,
        rework_pct: r.reworkPct ?? 0,
        redeployment_factor: r.redeploymentFactor ?? 1,
        qa_cost_per_outcome: r.qaCostPerOutcome ?? 0,
        eval_cost_per_outcome: r.evalCostPerOutcome ?? 0,
        integration_cost_per_outcome: r.integrationCostPerOutcome ?? 0,
        platform_overhead_pct: r.platformOverheadPct ?? 0,
        updated_at: now,
      }));
      await this.ch.insertRows('roi_rates', rateRows);
    }
  }

  private async triggerAttribution(): Promise<boolean> {
    const base = (env('BADGERIQ_ATTRIBUTION_WORKER_URL') ?? 'http://localhost:8096').replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/run`, { method: 'POST' });
      if (!res.ok) {
        this.logger.warn(`attribution trigger returned ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`attribution trigger failed: ${String(err)}`);
      return false;
    }
  }

  private async pollVerification(
    tenantId: string,
    expectedOutcomes: number,
  ): Promise<{
    outcomesStamped: number;
    vRoiRows: number;
    attributionEdges: number;
  }> {
    const deadline = Date.now() + POLL_MAX_MS;
    let outcomesStamped = 0;
    let vRoiRows = 0;
    let attributionEdges = 0;

    while (Date.now() < deadline) {
      const stampedRows = await this.ch.queryScoped<{ cnt: number }>(
        `SELECT countIf(run_id != '') AS cnt
         FROM agentledger.outcomes FINAL
         WHERE tenant_id = {tenant:String}
           AND outcome_id LIKE 'bootstrap:%'`,
      );
      outcomesStamped = Number(stampedRows[0]?.cnt ?? 0);

      const vroiRows = await this.ch.queryScoped<{ cnt: number }>(
        `SELECT count() AS cnt
         FROM agentledger.v_roi
         WHERE tenant_id = {tenant:String} AND agent_id != ''`,
      );
      vRoiRows = Number(vroiRows[0]?.cnt ?? 0);

      const edgeRows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<{ cnt: bigint }[]>`SELECT count(*)::bigint AS cnt FROM attribution_edges`,
      );
      attributionEdges = Number(edgeRows[0]?.cnt ?? 0);

      if (outcomesStamped >= expectedOutcomes && vRoiRows > 0) {
        break;
      }
      await sleep(POLL_MS);
    }

    return {
      outcomesStamped,
      vRoiRows,
      attributionEdges,
    };
  }

  private async lariSummaries(profile: DesignPartnerProfile): Promise<LariAgentSummary[]> {
    const { from, to } = profile.presentation;
    const summaries: LariAgentSummary[] = [];

    for (const agent of profile.agents) {
      try {
        const result = await this.lari.computeForAgent(agent.name, from, to);
        summaries.push({
          agentId: agent.name,
          lari: result.lari,
          netValueUsd: result.netValueUsd,
          fullyLoadedCostUsd: result.fullyLoadedCostUsd,
          confidenceScore: result.confidenceScore,
          recommendation: result.recommendation,
          outcomeCount: profile.runs.filter((r) => r.agentId === agent.name).length,
        });
      } catch (err) {
        this.logger.warn(`LARI compute failed for ${agent.name}: ${String(err)}`);
        summaries.push({
          agentId: agent.name,
          lari: 0,
          netValueUsd: 0,
          fullyLoadedCostUsd: 0,
          confidenceScore: 0,
          recommendation: 'improve_evidence',
          outcomeCount: 0,
        });
      }
    }

    return summaries;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import {
  PROVIDER_SOURCE_BREAKDOWN_SQL,
  RECONCILED_MODEL_USAGE_SQL,
  RECONCILED_PROVIDER_SPEND_SQL,
} from '../connectors/metered-cost';
import { PrismaService } from '../prisma/prisma.service';
import { rankProviders } from './lari-recommendations';
import { LariRecommendationsService } from './lari-recommendations.service';
import { buildProductWorthScorecard } from './lari-product-worth';
import {
  ConnectorPresence,
  ImportStats,
  OutcomeStats,
  ProductSpendBySource,
} from './lari-product-worth.types';
import { getTenantId } from '../tenant/tenant-context';

const MS_DAY = 86_400_000;
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

@Injectable()
export class LariProductWorthService {
  constructor(
    private readonly recommendations: LariRecommendationsService,
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
  ) {}

  async getProductWorth(from?: string, to?: string) {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }

    const engineInput = await this.recommendations.assembleEngineInput(tenantId, from, to);
    const priorRange = this.priorRange(engineInput.from, engineInput.to, engineInput.periodDays);
    const params = { from: engineInput.from, to: engineInput.to } as Record<string, ChParam>;

    const [
      priorProviderSpend,
      priorModelUsage,
      sourceBreakdown,
      outcomeStats,
      importStats,
      connectors,
    ] = await Promise.all([
      this.ch.queryScoped<{ provider: string; cost_usd: number }>(
        RECONCILED_PROVIDER_SPEND_SQL,
        priorRange as Record<string, ChParam>,
      ),
      this.ch.queryScoped<{ provider: string; model: string; cost_usd: number }>(
        RECONCILED_MODEL_USAGE_SQL,
        priorRange as Record<string, ChParam>,
      ),
      this.ch.queryScoped<{
        provider: string;
        portal_import_usd: number;
        connector_usd: number;
        live_usd: number;
        portal_import_calls: number;
        connector_calls: number;
        live_calls: number;
      }>(PROVIDER_SOURCE_BREAKDOWN_SQL, params),
      this.fetchOutcomeStats(params),
      this.fetchImportStats(tenantId, engineInput.from, engineInput.to),
      this.fetchConnectorPresence(tenantId),
    ]);

    const spendBySource = new Map<string, ProductSpendBySource>();
    for (const row of sourceBreakdown) {
      spendBySource.set(String(row.provider).trim().toLowerCase(), {
        portalImportUsd: n(row.portal_import_usd),
        connectorUsd: n(row.connector_usd),
        liveUsd: n(row.live_usd),
        portalImportCalls: n(row.portal_import_calls),
        connectorCalls: n(row.connector_calls),
        liveCalls: n(row.live_calls),
      });
    }

    const providerRankings = rankProviders(
      engineInput.providerSpend,
      engineInput.agentProviderSpend,
      engineInput.agentEconomics,
    );

    return buildProductWorthScorecard(engineInput.from, engineInput.to, {
      periodDays: engineInput.periodDays,
      providerSpend: engineInput.providerSpend,
      subscriptionPlans: engineInput.subscriptionPlans,
      providerRankings,
      modelUsage: engineInput.modelUsage,
      userUtilization: engineInput.userUtilization ?? [],
      copilotRoiPct: engineInput.copilotRoiPct,
      priorProviderSpend: priorProviderSpend.map((p) => ({
        provider: String(p.provider),
        costUsd: n(p.cost_usd),
      })),
      priorModelUsage: priorModelUsage.map((m) => ({
        provider: String(m.provider),
        model: String(m.model),
        costUsd: n(m.cost_usd),
      })),
      dailySpend: engineInput.dailySpend,
      agents: engineInput.agentEconomics.map((a) => ({
        agentId: a.agentId,
        costUsd: a.costUsd,
        valueUsd: a.valueUsd,
        lari: a.lari,
        recommendation: a.recommendation,
      })),
      spendBySource,
      outcomeStats,
      importStats,
      connectors,
    });
  }

  private async fetchOutcomeStats(
    params: Record<string, ChParam>,
  ): Promise<OutcomeStats> {
    const [outcomeRows, roiRows] = await Promise.all([
      this.ch.queryScoped<{
        total_outcomes: number;
        import_outcomes: number;
        connector_outcomes: number;
        api_outcomes: number;
        total_value_usd: number;
      }>(
        `SELECT
           count() AS total_outcomes,
           countIf(source_system = 'import') AS import_outcomes,
           countIf(source_system IN ('github', 'jira', 'zendesk')) AS connector_outcomes,
           countIf(source_system = 'api') AS api_outcomes,
           sum(business_value_usd) AS total_value_usd
         FROM outcomes
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}`,
        params,
      ),
      this.ch.queryScoped<{
        roi_linked: number;
        roi_value_usd: number;
        headline_eligible: number;
      }>(
        `SELECT
           count() AS roi_linked,
           sum(value_usd) AS roi_value_usd,
           countIf(headline_eligible) AS headline_eligible
         FROM v_roi
         WHERE tenant_id = {tenant:String}
           AND toDate(outcome_ts) BETWEEN {from:Date} AND {to:Date}`,
        params,
      ),
    ]);

    const o = outcomeRows[0];
    const r = roiRows[0];
    return {
      totalOutcomes: n(o?.total_outcomes),
      importOutcomes: n(o?.import_outcomes),
      connectorOutcomes: n(o?.connector_outcomes),
      apiOutcomes: n(o?.api_outcomes),
      totalValueUsd: n(o?.total_value_usd),
      roiLinkedOutcomes: n(r?.roi_linked),
      roiLinkedValueUsd: n(r?.roi_value_usd),
      headlineEligibleOutcomes: n(r?.headline_eligible),
    };
  }

  private async fetchImportStats(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<ImportStats> {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T23:59:59.999Z`);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [portalRuns, bulkImports] = await Promise.all([
        tx.portalImportRun.count({
          where: {
            tenantId,
            createdAt: { gte: start, lte: end },
            deletedAt: null,
          },
        }),
        tx.importIdempotency.count({
          where: {
            tenantId,
            importedAt: { gte: start, lte: end },
          },
        }),
      ]);
      return { portalImportRuns: portalRuns, bulkImportEvents: bulkImports };
    });
  }

  private async fetchConnectorPresence(tenantId: string): Promise<ConnectorPresence> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.connector.findMany({
        where: { tenantId, enabled: true, status: { not: 'draft' } },
        select: { provider: true, category: true, kind: true, displayName: true },
      }),
    );

    const billingConnectors: string[] = [];
    const outcomeConnectors: string[] = [];

    for (const row of rows) {
      const label = row.displayName ?? row.provider ?? row.kind ?? 'connector';
      const cat = (row.category ?? '').toLowerCase();
      if (cat === 'outcome_system' || cat.includes('outcome')) {
        outcomeConnectors.push(label);
      } else {
        billingConnectors.push(label);
      }
    }

    return { billingConnectors, outcomeConnectors };
  }

  private priorRange(from: string, to: string, periodDays: number): { from: string; to: string } {
    const start = new Date(`${from}T00:00:00.000Z`);
    const priorEnd = new Date(start.getTime() - MS_DAY);
    const priorStart = new Date(priorEnd.getTime() - (periodDays - 1) * MS_DAY);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: iso(priorStart), to: iso(priorEnd) };
  }
}

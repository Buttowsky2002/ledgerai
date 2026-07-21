import { BadRequestException, Injectable } from '@nestjs/common';
import { ChParam } from '../clickhouse/clickhouse.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { UserValueService } from '../analytics/user-value.service';
import {
  EFFECTIVE_METERED_COST_USD,
  LLM_CALLS_METERED_SCOPE,
  RECONCILED_MODEL_USAGE_SQL,
  RECONCILED_PROVIDER_SPEND_SQL,
  RECONCILED_TENANT_DAILY_SPEND_SQL,
  RECONCILED_UNMAPPED_SPEND_SQL,
} from '../connectors/metered-cost';
import { COPILOT_PROVIDER } from '../github-copilot/github-copilot.types';
import { PrismaService } from '../prisma/prisma.service';
import { getPerUserAnalyticsMode } from '../tenant/per-user-analytics';
import { getTenantId } from '../tenant/tenant-context';
import { generateLariRecommendations } from './lari-recommendations';
import {
  AgentEconomicsHighlight,
  LariRecommendationsInput,
  LariRecommendationsResponse,
} from './lari-recommendations.types';
import { ModelRate } from './model-equivalence';
import { LariService } from './lari.service';
import { Recommendation } from './lari.types';

type Range = { from: string; to: string };

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const MS_DAY = 86_400_000;

/**
 * Assembles data from ClickHouse + Postgres and runs the LARI recommendations
 * engine (deterministic statistical ML — no LLM financial figures).
 */
@Injectable()
export class LariRecommendationsService {
  constructor(
    private readonly ch: AnalyticsStore,
    private readonly prisma: PrismaService,
    private readonly lari: LariService,
    private readonly userValue: UserValueService,
  ) {}

  async getRecommendations(from?: string, to?: string): Promise<LariRecommendationsResponse> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const r = this.range(from, to, 365);
    const periodDays = Math.max(
      1,
      (new Date(r.to).getTime() - new Date(r.from).getTime()) / MS_DAY + 1,
    );
    const params: Record<string, ChParam> = { ...r };

    const [
      providerSpend,
      dailySpend,
      unmappedSpend,
      agentIds,
      agentProviderSpend,
      modelUsageRows,
      priceBook,
      seatStats,
      subscriptionPlans,
      copilotInactive,
      perUserMode,
    ] = await Promise.all([
      this.ch.queryScoped<{ provider: string; cost_usd: number; calls: number }>(
        RECONCILED_PROVIDER_SPEND_SQL,
        params,
      ),
      this.ch.queryScoped<{ day: string; cost_usd: number }>(
        RECONCILED_TENANT_DAILY_SPEND_SQL,
        params,
      ),
      this.ch.queryScoped<{ unmapped_cost: number }>(RECONCILED_UNMAPPED_SPEND_SQL, params),
      this.ch.queryScoped<{ agent_id: string }>(
        `SELECT agent_id, sum(value_usd) AS value_usd
         FROM agentledger.v_agent_daily_unit_economics
         WHERE tenant_id = {tenant:String} AND day BETWEEN {from:Date} AND {to:Date}
         GROUP BY agent_id ORDER BY value_usd DESC LIMIT 25`,
        params,
      ),
      this.ch.queryScoped<{ agent_id: string; provider: string; cost_usd: number }>(
        `SELECT agent_id, provider, sum(${EFFECTIVE_METERED_COST_USD}) AS cost_usd
         FROM llm_calls
         WHERE tenant_id = {tenant:String}
           AND toDate(ts) BETWEEN {from:Date} AND {to:Date}
           AND agent_id != ''
           AND ${LLM_CALLS_METERED_SCOPE}
         GROUP BY agent_id, provider`,
        params,
      ),
      this.ch.queryScoped<{
        provider: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        calls: number;
      }>(RECONCILED_MODEL_USAGE_SQL, params),
      this.loadPriceBookAt(r.to),
      this.seatStats(tenantId),
      this.subscriptionPlans(tenantId),
      this.copilotInactiveSeats(tenantId),
      getPerUserAnalyticsMode(this.prisma, tenantId),
    ]);

    const userUtilization = await this.userValue.assembleUserUtilization(tenantId, r, perUserMode);

    const agentEconomics = await this.buildAgentEconomics(
      agentIds.map((a) => a.agent_id),
      agentProviderSpend,
      r,
    );

    const engineInput: LariRecommendationsInput = {
      from: r.from,
      to: r.to,
      periodDays,
      seatStats,
      subscriptionPlans,
      providerSpend: providerSpend.map((p) => ({
        provider: String(p.provider),
        costUsd: n(p.cost_usd),
        calls: n(p.calls),
      })),
      dailySpend: dailySpend.map((d) => ({
        day: String(d.day).slice(0, 10),
        costUsd: n(d.cost_usd),
      })),
      unmappedCostUsd: n(unmappedSpend[0]?.unmapped_cost),
      agentEconomics,
      agentProviderSpend: agentProviderSpend.map((row) => ({
        agentId: String(row.agent_id),
        provider: String(row.provider),
        costUsd: n(row.cost_usd),
      })),
      copilotInactiveSeats: copilotInactive.count,
      copilotSeatMonthlyCost: copilotInactive.seatPrice,
      modelUsage: modelUsageRows.map((row) => ({
        provider: String(row.provider),
        model: String(row.model),
        inputTokens: n(row.input_tokens),
        outputTokens: n(row.output_tokens),
        costUsd: n(row.cost_usd),
        calls: n(row.calls),
      })),
      priceBook,
      userUtilization,
      perUserMode,
    };

    const { recommendations, providerRankings } = generateLariRecommendations(engineInput);

    const totalEstimatedSavingsUsd = recommendations.reduce(
      (s, rec) => s + (rec.estimatedSavingsUsd ?? 0),
      0,
    );

    return {
      from: r.from,
      to: r.to,
      recommendations,
      providerRankings,
      agentEconomicsHighlights: agentEconomics,
      summary: {
        totalEstimatedSavingsUsd: Math.round(totalEstimatedSavingsUsd * 100) / 100,
        highPriorityCount: recommendations.filter((rec) => rec.priority === 'high').length,
        criticalCount: recommendations.filter((rec) => rec.priority === 'critical').length,
      },
    };
  }

  private async buildAgentEconomics(
    agentIds: string[],
    agentProviderSpend: { agent_id: string; provider: string; cost_usd: number }[],
    r: Range,
  ): Promise<AgentEconomicsHighlight[]> {
    const topProviderByAgent = new Map<string, string>();
    const spendByAgent = new Map<string, Map<string, number>>();
    for (const row of agentProviderSpend) {
      const agentId = String(row.agent_id);
      const map = spendByAgent.get(agentId) ?? new Map();
      map.set(String(row.provider), (map.get(String(row.provider)) ?? 0) + n(row.cost_usd));
      spendByAgent.set(agentId, map);
    }
    for (const [agentId, providers] of spendByAgent) {
      let top = '';
      let topCost = 0;
      for (const [provider, cost] of providers) {
        if (cost > topCost) {
          topCost = cost;
          top = provider;
        }
      }
      if (top) topProviderByAgent.set(agentId, top);
    }

    const rows: AgentEconomicsHighlight[] = [];
    for (const agentId of agentIds) {
      const result = await this.lari.computeForAgent(agentId, r.from, r.to);
      rows.push({
        agentId,
        costUsd: result.fullyLoadedCostUsd,
        valueUsd: result.attributedIncrementalValueUsd,
        lari: result.lari,
        confidenceScore: result.confidenceScore,
        recommendation: result.recommendation as Recommendation,
        topProvider: topProviderByAgent.get(agentId),
      });
    }
    return rows.sort((a, b) => b.valueUsd - a.valueUsd);
  }

  private range(from: string | undefined, to: string | undefined, days = 365): Range {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - days);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: from ?? iso(start), to: to ?? iso(today) };
  }

  private async seatStats(tenantId: string): Promise<{ purchased: number; active: number }> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<{ purchased: number; active: number }[]>`
        SELECT
          COALESCE(SUM(p.seats_purchased), 0)::int AS purchased,
          COALESCE(SUM(CASE WHEN s.active THEN s.seats_assigned ELSE 0 END), 0)::int AS active
        FROM ai_subscription_plans p
        LEFT JOIN ai_seats s ON s.plan_id = p.plan_id`,
    );
    return { purchased: n(rows[0]?.purchased), active: n(rows[0]?.active) };
  }

  private async subscriptionPlans(tenantId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<
        {
          plan_id: string;
          provider: string;
          plan_name: string;
          seats_purchased: number;
          contract_monthly_cost: number | string;
          monthly_price_per_user: number | string;
          active_seats: number;
        }[]
      >`
        SELECT
          p.plan_id,
          p.provider,
          p.plan_name,
          p.seats_purchased,
          p.contract_monthly_cost,
          p.monthly_price_per_user,
          COALESCE(SUM(CASE WHEN s.active THEN s.seats_assigned ELSE 0 END), 0)::int AS active_seats
        FROM ai_subscription_plans p
        LEFT JOIN ai_seats s ON s.plan_id = p.plan_id
        GROUP BY p.plan_id, p.provider, p.plan_name, p.seats_purchased,
                 p.contract_monthly_cost, p.monthly_price_per_user`,
    );
    return rows.map((p) => ({
      planId: String(p.plan_id),
      provider: String(p.provider),
      planName: String(p.plan_name),
      seatsPurchased: n(p.seats_purchased),
      contractMonthlyCost: n(p.contract_monthly_cost),
      monthlyPricePerUser: n(p.monthly_price_per_user),
      activeSeats: n(p.active_seats),
    }));
  }

  private async copilotInactiveSeats(
    tenantId: string,
  ): Promise<{ count: number; seatPrice: number }> {
    const connections = await this.prisma.withTenant(tenantId, async (tx) => {
      const conns = await tx.aiProviderConnection.findMany({
        where: { tenantId, provider: COPILOT_PROVIDER },
        select: { connectionId: true },
      });
      if (conns.length === 0) return { connections: conns, seats: [] as { lastActivityAt: Date | null }[] };
      const connectionIds = conns.map((c) => c.connectionId);
      const seatRows = await tx.githubCopilotSeat.findMany({
        where: { tenantId, connectionId: { in: connectionIds }, isActive: true },
        select: { lastActivityAt: true },
      });
      return { connections: conns, seats: seatRows };
    });
    if (connections.connections.length === 0) return { count: 0, seatPrice: 19 };

    const seats = connections.seats;
    const now = Date.now();
    const inactive = seats.filter((s) => {
      if (!s.lastActivityAt) return true;
      return (now - s.lastActivityAt.getTime()) / MS_DAY >= 14;
    });
    return { count: inactive.length, seatPrice: 19 };
  }

  /** Global price book rows effective at range end — pivoted to input/output ModelRate pairs. */
  private async loadPriceBookAt(effectiveDate: string): Promise<ModelRate[]> {
    const at = new Date(`${effectiveDate}T23:59:59.999Z`);
    const rows = await this.prisma.priceBook.findMany({
      where: {
        effectiveStart: { lte: at },
        OR: [{ effectiveEnd: null }, { effectiveEnd: { gt: at } }],
        tokenType: { in: ['input', 'output'] },
      },
      select: {
        provider: true,
        modelPrefix: true,
        tokenType: true,
        usdPerMillion: true,
      },
    });

    const byModel = new Map<string, Partial<ModelRate>>();
    for (const row of rows) {
      const key = `${row.provider}::${row.modelPrefix}`;
      const entry = byModel.get(key) ?? {
        provider: row.provider,
        model: row.modelPrefix,
      };
      const rate = n(row.usdPerMillion);
      if (row.tokenType === 'input') entry.inputUsdPerM = rate;
      if (row.tokenType === 'output') entry.outputUsdPerM = rate;
      byModel.set(key, entry);
    }

    return [...byModel.values()].filter(
      (r): r is ModelRate =>
        r.inputUsdPerM !== undefined &&
        r.outputUsdPerM !== undefined &&
        r.provider !== undefined &&
        r.model !== undefined,
    );
  }
}

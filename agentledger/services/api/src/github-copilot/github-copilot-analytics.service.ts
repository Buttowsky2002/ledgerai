import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { mergeRoiAssumptions } from './github-copilot-roi';
import { COPILOT_PROVIDER, CopilotRoiAssumptions } from './github-copilot.types';

export const COPILOT_ANALYTICS_PROVIDER = 'github_copilot';
export const COPILOT_ANALYTICS_PLATFORM = 'GitHub Copilot';

export interface CopilotDailySpend {
  day: string;
  cost_usd: number;
}

export interface CopilotModelMixRow {
  provider: string;
  model: string;
  cost_usd: number;
  calls: number;
}

export interface CopilotSpendSummary {
  totalCostUsd: number;
  estimatedValueUsd: number;
  totalCalls: number;
  daily: CopilotDailySpend[];
  modelMix: CopilotModelMixRow[];
  platform: { platform: string; cost_usd: number; calls: number };
}

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

/** Enumerate ISO dates inclusive from `from` through `to`. */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/**
 * Aggregates GitHub Copilot license + usage cost from Postgres for portfolio
 * analytics (Overview, Model Mix, CFO view, cost-per-outcome). Seat cost is
 * prorated daily; overage is taken from org-level ROI snapshots per day.
 */
@Injectable()
export class CopilotAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSpendSummary(tenantId: string, from: string, to: string): Promise<CopilotSpendSummary | null> {
    const connections = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findMany({
        where: { tenantId, provider: COPILOT_PROVIDER },
        select: { connectionId: true, roiAssumptions: true },
      }),
    );
    if (connections.length === 0) return null;

    const connectionIds = connections.map((c) => c.connectionId);
    const assumptions = mergeRoiAssumptions(
      connections[0]?.roiAssumptions as Partial<CopilotRoiAssumptions>,
    );
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);

    const [usage, roiRows, seats, memberSpendRows] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotUsageDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
          },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotRoiDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
            teamSlug: '',
          },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotSeat.findMany({
          where: { tenantId, connectionId: { in: connectionIds }, isActive: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotMemberSpendDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
          },
          select: {
            usageDate: true,
            totalAllocatedCost: true,
            estimatedValueCreated: true,
          },
        }),
      ),
    ]);

    if (memberSpendRows.length > 0) {
      return this.buildSummaryFromMemberSpend(memberSpendRows, usage);
    }

    const assignedSeats = seats.length;
    const baseSeatCost =
      roiRows.length > 0
        ? Math.max(...roiRows.map((r) => Number(r.baseSeatCost)))
        : assignedSeats * assumptions.seatPriceUsd;
    const dailySeatRate = baseSeatCost / 30;

    const overageByDay = new Map<string, number>();
    let estimatedValueUsd = 0;
    for (const row of roiRows) {
      const day = row.usageDate.toISOString().slice(0, 10);
      overageByDay.set(day, (overageByDay.get(day) ?? 0) + Number(row.overageEstimate));
      estimatedValueUsd += Number(row.estimatedValue);
    }

    const days = enumerateDays(from, to);
    const daily: CopilotDailySpend[] = days.map((day) => ({
      day,
      cost_usd: usd(dailySeatRate + (overageByDay.get(day) ?? 0)),
    }));
    const totalCostUsd = usd(daily.reduce((s, d) => s + d.cost_usd, 0));

    const modelWeights = new Map<string, number>();
    let totalCalls = 0;
    for (const u of usage) {
      const weight = u.linesAccepted + u.chatTurns + u.acceptancesCount + u.prSummaryCount;
      totalCalls += u.acceptancesCount + u.chatTurns + u.prSummaryCount;
      const model = u.model?.trim() || u.feature?.trim() || 'copilot-business';
      modelWeights.set(model, (modelWeights.get(model) ?? 0) + weight);
    }
    const totalWeight = [...modelWeights.values()].reduce((s, w) => s + w, 0);
    const modelMix: CopilotModelMixRow[] =
      totalWeight > 0
        ? [...modelWeights.entries()].map(([model, weight]) => ({
            provider: COPILOT_ANALYTICS_PROVIDER,
            model,
            cost_usd: usd(totalCostUsd * (weight / totalWeight)),
            calls: Math.round(totalCalls * (weight / totalWeight)),
          }))
        : [
            {
              provider: COPILOT_ANALYTICS_PROVIDER,
              model: 'copilot-business',
              cost_usd: totalCostUsd,
              calls: totalCalls,
            },
          ];

    return {
      totalCostUsd,
      estimatedValueUsd: usd(estimatedValueUsd),
      totalCalls,
      daily,
      modelMix,
      platform: {
        platform: COPILOT_ANALYTICS_PLATFORM,
        cost_usd: totalCostUsd,
        calls: totalCalls,
      },
    };
  }

  private buildSummaryFromMemberSpend(
    memberSpendRows: {
      usageDate: Date;
      totalAllocatedCost: unknown;
      estimatedValueCreated: unknown;
    }[],
    usage: {
      linesAccepted: number;
      chatTurns: number;
      acceptancesCount: number;
      prSummaryCount: number;
      model: string;
      feature: string;
    }[],
  ): CopilotSpendSummary {
    const dailyMap = new Map<string, number>();
    let estimatedValueUsd = 0;
    for (const row of memberSpendRows) {
      const day = row.usageDate.toISOString().slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + Number(row.totalAllocatedCost));
      estimatedValueUsd += Number(row.estimatedValueCreated);
    }
    const daily: CopilotDailySpend[] = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, cost_usd]) => ({ day, cost_usd: usd(cost_usd) }));
    const totalCostUsd = usd(daily.reduce((s, d) => s + d.cost_usd, 0));

    const modelWeights = new Map<string, number>();
    let totalCalls = 0;
    for (const u of usage) {
      const weight = u.linesAccepted + u.chatTurns + u.acceptancesCount + u.prSummaryCount;
      totalCalls += u.acceptancesCount + u.chatTurns + u.prSummaryCount;
      const model = u.model?.trim() || u.feature?.trim() || 'copilot-business';
      modelWeights.set(model, (modelWeights.get(model) ?? 0) + weight);
    }
    const totalWeight = [...modelWeights.values()].reduce((s, w) => s + w, 0);
    const modelMix: CopilotModelMixRow[] =
      totalWeight > 0
        ? [...modelWeights.entries()].map(([model, weight]) => ({
            provider: COPILOT_ANALYTICS_PROVIDER,
            model,
            cost_usd: usd(totalCostUsd * (weight / totalWeight)),
            calls: Math.round(totalCalls * (weight / totalWeight)),
          }))
        : [
            {
              provider: COPILOT_ANALYTICS_PROVIDER,
              model: 'copilot-business',
              cost_usd: totalCostUsd,
              calls: totalCalls,
            },
          ];

    return {
      totalCostUsd,
      estimatedValueUsd: usd(estimatedValueUsd),
      totalCalls,
      daily,
      modelMix,
      platform: {
        platform: COPILOT_ANALYTICS_PLATFORM,
        cost_usd: totalCostUsd,
        calls: totalCalls,
      },
    };
  }

  /** Allocate Copilot spend to GitHub logins by usage weight for executive person tables. */
  async getUserSpendAllocation(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<{ userId: string; costUsd: number; calls: number; topModel: string }[]> {
    const connections = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findMany({
        where: { tenantId, provider: COPILOT_PROVIDER },
        select: { connectionId: true },
      }),
    );
    if (connections.length === 0) return [];

    const connectionIds = connections.map((c) => c.connectionId);
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);

    const [memberSpend, usage] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotMemberSpendDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
          },
          select: {
            githubLogin: true,
            totalAllocatedCost: true,
            linesAccepted: true,
            chatTurns: true,
            prSummaryCount: true,
          },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotUsageDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
          },
          select: {
            githubLogin: true,
            model: true,
            feature: true,
            acceptancesCount: true,
            chatTurns: true,
            linesAccepted: true,
            prSummaryCount: true,
          },
        }),
      ),
    ]);

    if (memberSpend.length > 0) {
      const byLogin = new Map<string, { cost: number; calls: number; modelWeights: Map<string, number> }>();
      for (const row of memberSpend) {
        const login = row.githubLogin?.trim();
        if (!login) continue;
        const acc = byLogin.get(login) ?? { cost: 0, calls: 0, modelWeights: new Map() };
        acc.cost += Number(row.totalAllocatedCost);
        acc.calls += row.linesAccepted + row.chatTurns + row.prSummaryCount;
        byLogin.set(login, acc);
      }
      for (const row of usage) {
        const login = row.githubLogin?.trim();
        if (!login) continue;
        const acc = byLogin.get(login) ?? { cost: 0, calls: 0, modelWeights: new Map() };
        const model = row.model?.trim() || row.feature?.trim() || 'copilot-business';
        const weight = row.linesAccepted + row.chatTurns + row.acceptancesCount + row.prSummaryCount;
        acc.modelWeights.set(model, (acc.modelWeights.get(model) ?? 0) + weight);
        byLogin.set(login, acc);
      }
      return [...byLogin.entries()]
        .map(([userId, acc]) => {
          let topModel = 'copilot-business';
          let topW = 0;
          for (const [model, w] of acc.modelWeights) {
            if (w > topW) {
              topW = w;
              topModel = model;
            }
          }
          return {
            userId,
            costUsd: usd(acc.cost),
            calls: acc.calls,
            topModel,
          };
        })
        .sort((a, b) => b.costUsd - a.costUsd);
    }

    const summary = await this.getSpendSummary(tenantId, from, to);
    if (!summary || summary.totalCostUsd <= 0) return [];

    type Acc = { weight: number; calls: number; modelWeights: Map<string, number> };
    const byUser = new Map<string, Acc>();
    for (const row of usage) {
      const login = row.githubLogin?.trim();
      if (!login) continue;
      const weight = row.linesAccepted + row.chatTurns + row.acceptancesCount + row.prSummaryCount;
      const calls = row.acceptancesCount + row.chatTurns + row.prSummaryCount;
      const model = row.model?.trim() || row.feature?.trim() || 'copilot-business';
      const acc = byUser.get(login) ?? { weight: 0, calls: 0, modelWeights: new Map() };
      acc.weight += weight;
      acc.calls += calls;
      acc.modelWeights.set(model, (acc.modelWeights.get(model) ?? 0) + weight);
      byUser.set(login, acc);
    }

    if (byUser.size === 0) {
      return [
        {
          userId: '__copilot_org__',
          costUsd: summary.totalCostUsd,
          calls: summary.totalCalls,
          topModel: 'copilot-business',
        },
      ];
    }

    const totalWeight = [...byUser.values()].reduce((s, u) => s + u.weight, 0) || 1;
    return [...byUser.entries()].map(([userId, acc]) => {
      const share = acc.weight / totalWeight;
      let topModel = 'copilot-business';
      let topW = 0;
      for (const [model, w] of acc.modelWeights) {
        if (w > topW) {
          topW = w;
          topModel = model;
        }
      }
      return {
        userId,
        costUsd: usd(summary.totalCostUsd * share),
        calls: Math.round(summary.totalCalls * share),
        topModel,
      };
    });
  }
}

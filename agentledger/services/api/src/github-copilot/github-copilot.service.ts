import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { recordAudit } from '../common/audit';
import { ConnectorSecretsService } from '../connectors/connector-secrets.service';
import { GitHubCopilotClient, GitHubCopilotApiError } from './github-copilot-client';
import { CopilotAnalyticsService } from './github-copilot-analytics.service';
import { generateCopilotFindings } from './github-copilot-findings';
import { mergeRoiAssumptions } from './github-copilot-roi';
import { GitHubCopilotSyncService } from './github-copilot-sync.service';
import {
  COPILOT_CONNECTION_TYPE,
  COPILOT_KIND,
  COPILOT_PROVIDER,
  CopilotConnectionStatus,
  CopilotOverviewCharts,
  CopilotOverviewMetrics,
  CopilotRoiAssumptions,
  CreateCopilotConnectionDto,
  DEFAULT_INCLUDED_CREDITS_PER_SEAT,
} from './github-copilot.types';

@Injectable()
export class GitHubCopilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ConnectorSecretsService,
    private readonly sync: GitHubCopilotSyncService,
    private readonly copilotAnalytics: CopilotAnalyticsService,
  ) {}

  async listConnections(): Promise<CopilotConnectionStatus[]> {
    const tenantId = this.requireTenant();
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findMany({
        where: { tenantId, provider: COPILOT_PROVIDER },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const statuses: CopilotConnectionStatus[] = [];
    for (const row of rows) {
      const connector = await this.prisma.withTenant(tenantId, (tx) =>
        tx.connector.findUnique({ where: { connectorId: row.connectorId } }),
      );
      statuses.push(this.toStatus(row, connector?.status ?? 'unknown'));
    }
    return statuses;
  }

  async getConnection(connectionId: string): Promise<CopilotConnectionStatus> {
    const tenantId = this.requireTenant();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findUnique({ where: { connectionId } }),
    );
    if (!row) throw new NotFoundException('connection not found');
    const connector = await this.prisma.withTenant(tenantId, (tx) =>
      tx.connector.findUnique({ where: { connectorId: row.connectorId } }),
    );
    return this.toStatus(row, connector?.status ?? 'unknown');
  }

  async createConnection(dto: CreateCopilotConnectionDto): Promise<CopilotConnectionStatus> {
    const tenantId = this.requireTenant();
    const orgSlug = dto.orgSlug.trim().toLowerCase();
    if (!orgSlug) throw new BadRequestException('orgSlug is required');
    if (!dto.githubToken?.trim()) throw new BadRequestException('githubToken is required');

    const client = new GitHubCopilotClient({ token: dto.githubToken.trim(), orgSlug });
    try {
      await client.validateToken();
    } catch (err) {
      const apiErr = err instanceof GitHubCopilotApiError ? err : null;
      throw new BadRequestException({
        message: apiErr?.message ?? 'GitHub token validation failed',
        hint: apiErr?.hint ?? 'Provide a token with Members (read), Copilot metrics (read), and Copilot seat management (read) for the organization.',
        code: apiErr?.code ?? 'token_invalid',
      });
    }

    const secretRef = await this.secrets.storeSecret(dto.githubToken.trim());
    const roiAssumptions = mergeRoiAssumptions(dto.roiAssumptions);
    const scheduleJson = dto.scheduleJson ?? { intervalMinutes: 5, enabled: true };

    return this.prisma.withTenant(tenantId, async (tx) => {
      const connector = await tx.connector.create({
        data: {
          tenantId,
          kind: COPILOT_KIND,
          displayName: dto.displayName,
          provider: COPILOT_PROVIDER,
          category: 'license_usage_roi',
          config: {
            orgSlug,
            enterpriseSlug: dto.enterpriseSlug ?? null,
            connectionType: COPILOT_CONNECTION_TYPE,
          } as Prisma.InputJsonValue,
          secretRef,
          scheduleJson: scheduleJson as Prisma.InputJsonValue,
          status: 'connected',
          enabled: true,
        },
      });

      const connection = await tx.aiProviderConnection.create({
        data: {
          tenantId,
          connectorId: connector.connectorId,
          provider: COPILOT_PROVIDER,
          connectionType: COPILOT_CONNECTION_TYPE,
          orgSlug,
          enterpriseSlug: dto.enterpriseSlug ?? null,
          displayName: dto.displayName,
          roiAssumptions: roiAssumptions as unknown as Prisma.InputJsonValue,
          scheduleJson: scheduleJson as Prisma.InputJsonValue,
        },
      });

      await recordAudit(tx, {
        action: 'create',
        object: `github_copilot_connection:${connection.connectionId}`,
        before: null,
        after: { orgSlug, displayName: dto.displayName },
      });

      const status = this.toStatus(connection, connector.status);
      // Kick off initial sync so the dashboard populates without a manual step.
      void this.sync.syncConnection(connection.connectionId, tenantId).catch(() => undefined);
      return status;
    });
  }

  async updateRoiAssumptions(
    connectionId: string,
    partial: Partial<CopilotRoiAssumptions>,
  ): Promise<CopilotConnectionStatus> {
    const tenantId = this.requireTenant();
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findUnique({ where: { connectionId } }),
    );
    if (!existing) throw new NotFoundException('connection not found');

    const merged = mergeRoiAssumptions({
      ...(existing.roiAssumptions as Partial<CopilotRoiAssumptions>),
      ...partial,
    });

    const updated = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.update({
        where: { connectionId },
        data: { roiAssumptions: merged as unknown as Prisma.InputJsonValue, updatedAt: new Date() },
      }),
    );
    const connector = await this.prisma.withTenant(tenantId, (tx) =>
      tx.connector.findUnique({ where: { connectorId: updated.connectorId } }),
    );
    return this.toStatus(updated, connector?.status ?? 'unknown');
  }

  async testToken(token: string, orgSlug: string): Promise<{ ok: boolean; orgName?: string; hint?: string }> {
    if (!token?.trim()) throw new BadRequestException('token is required');
    const client = new GitHubCopilotClient({ token: token.trim(), orgSlug: orgSlug.trim().toLowerCase() });
    try {
      const result = await client.validateToken();
      return { ok: true, orgName: result.orgName };
    } catch (err) {
      const apiErr = err instanceof GitHubCopilotApiError ? err : null;
      return { ok: false, hint: apiErr?.hint ?? apiErr?.message ?? 'Token validation failed' };
    }
  }

  async syncNow(connectionId: string) {
    const tenantId = this.requireTenant();
    return this.sync.syncConnection(connectionId, tenantId);
  }

  async getOverview(from?: string, to?: string) {
    const tenantId = this.requireTenant();
    const end = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
    const start = from
      ? new Date(`${from}T00:00:00.000Z`)
      : new Date(end.getTime() - 28 * 86_400_000);

    const connections = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findMany({ where: { tenantId, provider: COPILOT_PROVIDER } }),
    );
    if (connections.length === 0) {
      return {
        connected: false,
        metrics: null,
        charts: null,
        findings: [],
        connections: [],
        disclaimer: 'ROI figures are estimates based on configurable assumptions — not exact productivity measures.',
      };
    }

    const connectionIds = connections.map((c) => c.connectionId);
    const [seats, usage, roiRows] = await this.prisma.withTenant(tenantId, async (tx) => {
      const [seats, usage, roiRows] = await Promise.all([
        tx.githubCopilotSeat.findMany({ where: { tenantId, connectionId: { in: connectionIds } } }),
        tx.githubCopilotUsageDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
          },
        }),
        tx.githubCopilotRoiDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
          },
        }),
      ]);
      return [seats, usage, roiRows] as const;
    });

    const assumptions = mergeRoiAssumptions(
      connections[0]?.roiAssumptions as Partial<CopilotRoiAssumptions>,
    );

    const activeSeats = seats.filter((s) => {
      if (!s.isActive) return false;
      if (!s.lastActivityAt) return false;
      return (Date.now() - s.lastActivityAt.getTime()) / 86_400_000 <= 28;
    }).length;
    const inactiveSeats = seats.filter((s) => s.isActive).length - activeSeats;

    const aiCreditsUsed = usage.reduce((s, u) => s + Number(u.aiCreditsUsed), 0);
    const includedCredits = seats.filter((s) => s.isActive).length * assumptions.includedCreditsPerSeat;
    const creditUtilizationPct = includedCredits > 0 ? (aiCreditsUsed / includedCredits) * 100 : 0;

    const assignedSeatCount = seats.filter((s) => s.isActive).length;
    const seatBasedMonthlyCost = assignedSeatCount * assumptions.seatPriceUsd;

    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);
    const spendSummary = await this.copilotAnalytics.getSpendSummary(tenantId, startIso, endIso);

    const orgRoiRows = roiRows.filter((r) => !r.teamSlug);
    const totalValue = orgRoiRows.reduce((s, r) => s + Number(r.estimatedValue), 0);
    const totalHours = orgRoiRows.reduce((s, r) => s + Number(r.adjustedHoursSaved), 0);
    const totalCost = spendSummary?.totalCostUsd ?? seatBasedMonthlyCost;
    const roiPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

    const totalActiveUsers = usage.reduce((s, u) => Math.max(s, u.activeUsers), 0);
    const totalEngagedUsers = usage.reduce((s, u) => Math.max(s, u.engagedUsers), 0);
    const totalLinesAccepted = usage.reduce((s, u) => s + u.linesAccepted, 0);
    const activeUserDenom = Math.max(totalActiveUsers, activeSeats);
    const engagedUserDenom = Math.max(totalEngagedUsers, activeSeats);

    const metrics: CopilotOverviewMetrics = {
      monthlyCopilotSpend: round2(totalCost),
      activeSeats,
      inactiveSeats: Math.max(0, inactiveSeats),
      aiCreditsUsed: round2(aiCreditsUsed),
      creditUtilizationPct: round2(creditUtilizationPct),
      estimatedHoursSaved: round2(totalHours),
      estimatedValueCreated: round2(totalValue),
      roiPercentage: round2(roiPct),
      costPerActiveUser: activeUserDenom > 0 ? round2(totalCost / activeUserDenom) : 0,
      costPerEngagedUser: engagedUserDenom > 0 ? round2(totalCost / engagedUserDenom) : 0,
      costPerAcceptedLine: totalLinesAccepted > 0 ? round2(totalCost / totalLinesAccepted) : 0,
      isEstimated: true,
    };

    const charts = this.buildCharts(seats, usage, roiRows);
    const userUsageMap = new Map<string, { aiCreditsUsed: number; linesAccepted: number; acceptancesCount: number; teamSlug: string }>();
    for (const u of usage) {
      if (!u.githubLogin) continue;
      const cur = userUsageMap.get(u.githubLogin) ?? {
        aiCreditsUsed: 0,
        linesAccepted: 0,
        acceptancesCount: 0,
        teamSlug: u.teamSlug,
      };
      cur.aiCreditsUsed += Number(u.aiCreditsUsed);
      cur.linesAccepted += u.linesAccepted;
      cur.acceptancesCount += u.acceptancesCount;
      userUsageMap.set(u.githubLogin, cur);
    }

    const teamRoiMap = new Map<string, { roiPercentage: number; assignedSeats: number; activeSeats: number }>();
    for (const r of roiRows) {
      const team = r.teamSlug || '(org)';
      teamRoiMap.set(team, {
        roiPercentage: Number(r.roiPercentage),
        assignedSeats: r.assignedSeats,
        activeSeats: r.activeSeats,
      });
    }

    const findings = generateCopilotFindings({
      seats: seats.map((s) => ({
        githubLogin: s.githubLogin,
        assigningTeamSlug: s.assigningTeamSlug,
        lastActivityAt: s.lastActivityAt,
        pendingCancellationDate: s.pendingCancellationDate,
        isActive: s.isActive,
        monthlySeatCost: Number(s.monthlySeatCost),
      })),
      userUsage: [...userUsageMap.entries()].map(([githubLogin, u]) => ({
        githubLogin,
        teamSlug: u.teamSlug,
        aiCreditsUsed: u.aiCreditsUsed,
        linesAccepted: u.linesAccepted,
        acceptancesCount: u.acceptancesCount,
      })),
      teamRoi: [...teamRoiMap.entries()].map(([teamSlug, t]) => ({ teamSlug, ...t })),
      assumptions,
      includedCreditsPerUser: assumptions.includedCreditsPerSeat ?? DEFAULT_INCLUDED_CREDITS_PER_SEAT,
    });

    const connectionStatuses = await this.listConnections();

    return {
      connected: true,
      metrics,
      charts,
      findings,
      connections: connectionStatuses,
      roiAssumptions: assumptions,
      disclaimer:
        'All Copilot spend and ROI figures are estimated or allocated — GitHub does not provide a per-user invoice. ' +
        'Org totals equal the sum of member allocated spend (seat + credits + overage share) for synced days in the selected range.',
    };
  }

  private buildCharts(
    seats: { assigningTeamSlug: string | null; isActive: boolean; lastActivityAt: Date | null; monthlySeatCost: unknown }[],
    usage: {
      teamSlug: string;
      feature: string;
      githubLogin: string;
      language: string;
      model: string;
      aiCreditsUsed: unknown;
      linesAccepted: number;
      chatTurns: number;
      usageDate: Date;
      activeUsers: number;
      engagedUsers: number;
    }[],
    roiRows: { teamSlug: string; totalCopilotCost: unknown; roiPercentage: unknown; estimatedValue: unknown }[],
  ): CopilotOverviewCharts {
    const spendByTeam = aggregateBy(roiRows, (r) => r.teamSlug || '(org)', (r) => Number(r.totalCopilotCost));
    const usageByFeature = aggregateBy(usage, (u) => u.feature || '(unknown)', (u) => u.linesAccepted + u.chatTurns);
    const aiCreditsByUser = aggregateBy(
      usage.filter((u) => u.githubLogin),
      (u) => u.githubLogin,
      (u) => Number(u.aiCreditsUsed),
    )
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map((r) => ({ user: r.key, credits: r.count }));
    const acceptedLinesByLanguage = aggregateBy(
      usage.filter((u) => u.language),
      (u) => u.language,
      (u) => u.linesAccepted,
    ).map((r) => ({ language: r.key, lines: r.count }));
    const modelMix = aggregateBy(
      usage.filter((u) => u.model),
      (u) => u.model,
      (u) => u.linesAccepted + u.chatTurns,
    ).map((r) => ({ model: r.key, count: r.count }));

    const now = Date.now();
    const seatWaste = [
      { bucket: 'Active (≤14d)', seats: 0, wasteUsd: 0 },
      { bucket: 'Inactive 14–29d', seats: 0, wasteUsd: 0 },
      { bucket: 'Inactive 30d+', seats: 0, wasteUsd: 0 },
    ];
    for (const s of seats) {
      if (!s.isActive) continue;
      const cost = Number(s.monthlySeatCost);
      const days = s.lastActivityAt ? (now - s.lastActivityAt.getTime()) / 86_400_000 : Infinity;
      if (days <= 14) seatWaste[0].seats += 1;
      else if (days < 30) {
        seatWaste[1].seats += 1;
        seatWaste[1].wasteUsd += cost;
      } else {
        seatWaste[2].seats += 1;
        seatWaste[2].wasteUsd += cost;
      }
    }

    const roiByTeam = aggregateBy(roiRows, (r) => r.teamSlug || '(org)', (r) => Number(r.roiPercentage))
      .map((r) => ({
        team: r.key,
        roiPct: round2(r.count),
        estimatedValue: round2(
          roiRows
            .filter((x) => (x.teamSlug || '(org)') === r.key)
            .reduce((s, x) => s + Number(x.estimatedValue), 0),
        ),
      }));

    const adoptionByDay = new Map<string, { activeUsers: number; engagedUsers: number }>();
    for (const u of usage) {
      const day = u.usageDate.toISOString().slice(0, 10);
      const cur = adoptionByDay.get(day) ?? { activeUsers: 0, engagedUsers: 0 };
      cur.activeUsers = Math.max(cur.activeUsers, u.activeUsers);
      cur.engagedUsers = Math.max(cur.engagedUsers, u.engagedUsers);
      adoptionByDay.set(day, cur);
    }
    const adoptionTrend = [...adoptionByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day: day.slice(5), activeUsers: v.activeUsers, engagedUsers: v.engagedUsers }));

    return {
      spendByTeam: spendByTeam.map((r) => ({ team: r.key, spend: round2(r.count) })),
      usageByFeature: usageByFeature.map((r) => ({ feature: r.key, count: r.count })),
      aiCreditsByUser,
      acceptedLinesByLanguage,
      modelMix,
      seatWaste: seatWaste.map((b) => ({ ...b, wasteUsd: round2(b.wasteUsd) })),
      roiByTeam,
      adoptionTrend,
    };
  }

  private toStatus(
    row: {
      connectionId: string;
      connectorId: string;
      orgSlug: string;
      displayName: string | null;
      lastSuccessAt: Date | null;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      recordsImported: number;
      roiAssumptions: unknown;
    },
    status: string,
  ): CopilotConnectionStatus {
    return {
      connectionId: row.connectionId,
      connectorId: row.connectorId,
      orgSlug: row.orgSlug,
      displayName: row.displayName,
      status,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      recordsImported: row.recordsImported,
      roiAssumptions: mergeRoiAssumptions(row.roiAssumptions as Partial<CopilotRoiAssumptions>),
    };
  }

  private requireTenant(): string {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant in context');
    return tenantId;
  }
}

function aggregateBy<T>(
  items: T[],
  keyFn: (item: T) => string,
  valFn: (item: T) => number,
): { key: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = keyFn(item) || '(unknown)';
    map.set(k, (map.get(k) ?? 0) + valFn(item));
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

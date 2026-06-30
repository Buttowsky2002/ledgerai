import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateMemberSpendFindings } from './github-copilot-findings';
import { mergeRoiAssumptions } from './github-copilot-roi';
import {
  COPILOT_PROVIDER,
  CopilotMemberSpendCharts,
  CopilotMemberSpendResponse,
  CopilotMemberSpendRow,
  CopilotMemberSpendSummary,
  CopilotRoiAssumptions,
} from './github-copilot.types';

export interface MemberSpendQuery {
  from?: string;
  to?: string;
  month?: string;
  team?: string;
  user?: string;
  utilizationStatus?: string;
  model?: string;
  editor?: string;
  language?: string;
}

const DISCLAIMER =
  'GitHub Copilot Business does not provide a per-user invoice. LedgerAI estimates member spend using seat allocation, usage metrics, AI credit usage, and proportional overage allocation. All spend and ROI values are estimated or allocated — not exact invoice amounts.';

@Injectable()
export class CopilotMemberSpendService {
  constructor(private readonly prisma: PrismaService) {}

  async getMemberSpend(tenantId: string, query: MemberSpendQuery): Promise<CopilotMemberSpendResponse> {
    const connections = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findMany({ where: { tenantId, provider: COPILOT_PROVIDER } }),
    );

    if (connections.length === 0) {
      return {
        connected: false,
        summary: null,
        members: [],
        charts: null,
        findings: [],
        filters: emptyFilters(),
        connections: [],
        disclaimer: DISCLAIMER,
        recordsImported: 0,
      };
    }

    const { from, to } = resolveDateRange(query);
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T23:59:59.999Z`);
    const connectionIds = connections.map((c) => c.connectionId);
    const assumptions = mergeRoiAssumptions(
      connections[0]?.roiAssumptions as Partial<CopilotRoiAssumptions>,
    );

    const [spendRows, seats, members, memberTeams, usageDetail] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotMemberSpendDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
            ...(query.team ? { teamSlug: query.team } : {}),
            ...(query.user ? { githubLogin: query.user } : {}),
            ...(query.utilizationStatus ? { utilizationStatus: query.utilizationStatus } : {}),
          },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotSeat.findMany({ where: { tenantId, connectionId: { in: connectionIds } } }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotMember.findMany({ where: { tenantId, connectionId: { in: connectionIds } } }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotMemberTeam.findMany({ where: { tenantId, connectionId: { in: connectionIds } } }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotUsageDaily.findMany({
          where: {
            tenantId,
            connectionId: { in: connectionIds },
            usageDate: { gte: start, lte: end },
            ...(query.model ? { model: query.model } : {}),
            ...(query.editor ? { editor: query.editor } : {}),
            ...(query.language ? { language: query.language } : {}),
          },
          select: {
            githubLogin: true,
            teamSlug: true,
            model: true,
            editor: true,
            language: true,
            usageDate: true,
            linesAccepted: true,
            chatTurns: true,
          },
        }),
      ),
    ]);

    const memberByLogin = new Map(members.map((m) => [m.githubLogin, m]));
    const teamNameBySlug = new Map(memberTeams.map((t) => [t.teamSlug, t.teamName]));
    const seatByLogin = new Map(seats.map((s) => [s.githubLogin, s]));

    const aggregated = aggregateSpendByMember(spendRows);
    const memberRows: CopilotMemberSpendRow[] = [...aggregated.entries()].map(([login, agg]) => {
      const member = memberByLogin.get(login);
      const seat = seatByLogin.get(login);
      const teamSlug = agg.teamSlug;
      return {
        githubLogin: login,
        displayName: member?.displayName ?? null,
        avatarUrl: member?.avatarUrl ?? null,
        teamSlug,
        teamName: teamNameBySlug.get(teamSlug) ?? teamSlug,
        seatStatus: resolveSeatStatus(seat),
        lastActivityAt: seat?.lastActivityAt?.toISOString() ?? null,
        seatCost: round2(agg.seatCost),
        aiCreditsUsed: round2(agg.aiCreditsUsed),
        estimatedCreditCost: round2(agg.estimatedCreditCost),
        allocatedOverageCost: round2(agg.allocatedOverageCost),
        totalAllocatedCost: round2(agg.totalAllocatedCost),
        linesAccepted: agg.linesAccepted,
        chatTurns: agg.chatTurns,
        prSummaryCount: agg.prSummaryCount,
        estimatedHoursSaved: round4(agg.estimatedHoursSaved),
        estimatedValueCreated: round2(agg.estimatedValueCreated),
        roiPercentage:
          agg.totalAllocatedCost > 0
            ? round2(((agg.estimatedValueCreated - agg.totalAllocatedCost) / agg.totalAllocatedCost) * 100)
            : null,
        utilizationStatus: agg.utilizationStatus,
        isEstimated: true as const,
      };
    });

    memberRows.sort((a, b) => b.totalAllocatedCost - a.totalAllocatedCost);

    const summary = buildSummary(memberRows, seats, assumptions);
    const charts = buildCharts(memberRows, spendRows, usageDetail);
    const findings = generateMemberSpendFindings({
      members: memberRows,
      seats: seats.map((s) => ({
        githubLogin: s.githubLogin,
        assigningTeamSlug: s.assigningTeamSlug,
        lastActivityAt: s.lastActivityAt,
        isActive: s.isActive,
        monthlySeatCost: Number(s.monthlySeatCost),
      })),
      memberTeams: memberTeams.map((t) => ({
        githubLogin: t.githubLogin,
        teamSlug: t.teamSlug,
        teamName: t.teamName,
      })),
      assumptions,
    });

    const recordsImported = connections.reduce((s, c) => s + c.recordsImported, 0);

    return {
      connected: true,
      summary,
      members: memberRows,
      charts,
      findings,
      filters: {
        teams: [...new Set(memberTeams.map((t) => t.teamSlug))].sort(),
        users: [...new Set(memberRows.map((m) => m.githubLogin))].sort(),
        utilizationStatuses: [...new Set(spendRows.map((r) => r.utilizationStatus))].sort(),
        models: [...new Set(usageDetail.map((u) => u.model).filter(Boolean))].sort(),
        editors: [...new Set(usageDetail.map((u) => u.editor).filter(Boolean))].sort(),
        languages: [...new Set(usageDetail.map((u) => u.language).filter(Boolean))].sort(),
      },
      connections: connections.map((c) => ({
        connectionId: c.connectionId,
        connectorId: c.connectorId,
        orgSlug: c.orgSlug,
        displayName: c.displayName,
        status: 'connected',
        lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
        lastErrorCode: c.lastErrorCode,
        lastErrorMessage: c.lastErrorMessage,
        recordsImported: c.recordsImported,
        roiAssumptions: assumptions,
      })),
      disclaimer: DISCLAIMER,
      recordsImported,
    };
  }
}

type Agg = {
  teamSlug: string;
  seatCost: number;
  estimatedCreditCost: number;
  allocatedOverageCost: number;
  totalAllocatedCost: number;
  aiCreditsUsed: number;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  estimatedHoursSaved: number;
  estimatedValueCreated: number;
  utilizationStatus: string;
};

function aggregateSpendByMember(
  rows: {
    githubLogin: string;
    teamSlug: string;
    seatCost: unknown;
    estimatedCreditCost: unknown;
    allocatedOverageCost: unknown;
    totalAllocatedCost: unknown;
    aiCreditsUsed: unknown;
    linesAccepted: number;
    chatTurns: number;
    prSummaryCount: number;
    estimatedHoursSaved: unknown;
    estimatedValueCreated: unknown;
    utilizationStatus: string;
  }[],
): Map<string, Agg> {
  const map = new Map<string, Agg>();
  for (const r of rows) {
    const cur = map.get(r.githubLogin) ?? {
      teamSlug: r.teamSlug,
      seatCost: 0,
      estimatedCreditCost: 0,
      allocatedOverageCost: 0,
      totalAllocatedCost: 0,
      aiCreditsUsed: 0,
      linesAccepted: 0,
      chatTurns: 0,
      prSummaryCount: 0,
      estimatedHoursSaved: 0,
      estimatedValueCreated: 0,
      utilizationStatus: r.utilizationStatus,
    };
    cur.seatCost += Number(r.seatCost);
    cur.estimatedCreditCost += Number(r.estimatedCreditCost);
    cur.allocatedOverageCost += Number(r.allocatedOverageCost);
    cur.totalAllocatedCost += Number(r.totalAllocatedCost);
    cur.aiCreditsUsed += Number(r.aiCreditsUsed);
    cur.linesAccepted += r.linesAccepted;
    cur.chatTurns += r.chatTurns;
    cur.prSummaryCount += r.prSummaryCount;
    cur.estimatedHoursSaved += Number(r.estimatedHoursSaved);
    cur.estimatedValueCreated += Number(r.estimatedValueCreated);
    if (r.utilizationStatus === 'inactive' || r.utilizationStatus === 'negative_roi') {
      cur.utilizationStatus = r.utilizationStatus;
    }
    map.set(r.githubLogin, cur);
  }
  return map;
}

function buildSummary(
  members: CopilotMemberSpendRow[],
  seats: { isActive: boolean; lastActivityAt: Date | null }[],
  assumptions: CopilotRoiAssumptions,
): CopilotMemberSpendSummary {
  const now = Date.now();
  const activeSeats = seats.filter((s) => {
    if (!s.isActive) return false;
    if (!s.lastActivityAt) return false;
    return (now - s.lastActivityAt.getTime()) / 86_400_000 <= 28;
  }).length;
  const inactiveSeats = seats.filter((s) => s.isActive).length - activeSeats;
  const allocatedMemberSpend = members.reduce((s, m) => s + m.totalAllocatedCost, 0);
  const totalCopilotSpend = allocatedMemberSpend;
  const wasted = members
    .filter((m) => m.utilizationStatus === 'inactive')
    .reduce((s, m) => s + m.seatCost, 0);

  const activeMembers = members.filter((m) => m.utilizationStatus === 'active' || m.utilizationStatus === 'high_usage');
  const engagedMembers = members.filter((m) => m.linesAccepted + m.chatTurns > 0);

  const highestSpend = members[0]
    ? { login: members[0].githubLogin, cost: members[0].totalAllocatedCost }
    : null;

  const withRoi = members.filter((m) => m.roiPercentage != null);
  const highestRoi = withRoi.reduce(
    (best, m) => (!best || (m.roiPercentage ?? -Infinity) > (best.roiPct ?? -Infinity) ? { login: m.githubLogin, roiPct: m.roiPercentage! } : best),
    null as { login: string; roiPct: number } | null,
  );
  const lowestRoi = withRoi.reduce(
    (worst, m) => (!worst || (m.roiPercentage ?? Infinity) < (worst.roiPct ?? Infinity) ? { login: m.githubLogin, roiPct: m.roiPercentage! } : worst),
    null as { login: string; roiPct: number } | null,
  );

  return {
    totalCopilotSpend: round2(totalCopilotSpend),
    allocatedMemberSpend: round2(allocatedMemberSpend),
    activePaidSeats: activeSeats,
    inactivePaidSeats: Math.max(0, inactiveSeats),
    estimatedWastedSpend: round2(wasted),
    avgCostPerActiveMember:
      activeMembers.length > 0 ? round2(allocatedMemberSpend / activeMembers.length) : 0,
    avgCostPerEngagedMember:
      engagedMembers.length > 0 ? round2(allocatedMemberSpend / engagedMembers.length) : 0,
    highestSpendMember: highestSpend,
    highestRoiMember: highestRoi,
    lowestRoiMember: lowestRoi,
    isEstimated: true,
  };
}

function buildCharts(
  members: CopilotMemberSpendRow[],
  spendRows: { usageDate: Date; githubLogin: string; totalAllocatedCost: unknown; estimatedValueCreated: unknown }[],
  usageDetail: { githubLogin: string; model: string; linesAccepted: number; chatTurns: number; usageDate: Date }[],
): CopilotMemberSpendCharts {
  const top = members.slice(0, 15);
  const teamSpend = new Map<string, number>();
  for (const m of members) {
    const team = m.teamSlug || '(unassigned)';
    teamSpend.set(team, (teamSpend.get(team) ?? 0) + m.totalAllocatedCost);
  }

  const modelMixMap = new Map<string, number>();
  for (const u of usageDetail) {
    if (!u.githubLogin || !u.model) continue;
    const key = `${u.githubLogin}|${u.model}`;
    modelMixMap.set(key, (modelMixMap.get(key) ?? 0) + u.linesAccepted + u.chatTurns);
  }

  const trendByDay = new Map<string, { spend: number; value: number }>();
  for (const r of spendRows) {
    const day = r.usageDate.toISOString().slice(0, 10);
    const cur = trendByDay.get(day) ?? { spend: 0, value: 0 };
    cur.spend += Number(r.totalAllocatedCost);
    cur.value += Number(r.estimatedValueCreated);
    trendByDay.set(day, cur);
  }

  return {
    spendLeaderboard: top.map((m) => ({ user: m.githubLogin, spend: m.totalAllocatedCost })),
    spendByTeam: [...teamSpend.entries()]
      .map(([team, spend]) => ({ team, spend: round2(spend) }))
      .sort((a, b) => b.spend - a.spend),
    inactiveSeatWaste: members
      .filter((m) => m.utilizationStatus === 'inactive')
      .map((m) => ({ user: m.githubLogin, wasteUsd: m.seatCost }))
      .sort((a, b) => b.wasteUsd - a.wasteUsd)
      .slice(0, 15),
    aiCreditsByMember: top.map((m) => ({ user: m.githubLogin, credits: m.aiCreditsUsed })),
    roiByMember: top
      .filter((m) => m.roiPercentage != null)
      .map((m) => ({ user: m.githubLogin, roiPct: m.roiPercentage! })),
    costVsValue: top.map((m) => ({
      user: m.githubLogin,
      cost: m.totalAllocatedCost,
      value: m.estimatedValueCreated,
    })),
    acceptedLinesByMember: top.map((m) => ({ user: m.githubLogin, lines: m.linesAccepted })),
    chatUsageByMember: top.map((m) => ({ user: m.githubLogin, turns: m.chatTurns })),
    usageTrendByDate: [...trendByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day: day.slice(5), spend: round2(v.spend), value: round2(v.value) })),
    modelMix: [...modelMixMap.entries()]
      .map(([key, count]) => {
        const [user, model] = key.split('|');
        return { user, model, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 30),
  };
}

function resolveSeatStatus(
  seat: { isActive: boolean; pendingCancellationDate?: Date | null } | undefined,
): CopilotMemberSpendRow['seatStatus'] {
  if (!seat) return 'no_seat';
  if (seat.pendingCancellationDate) return 'pending_cancel';
  if (!seat.isActive) return 'inactive';
  return 'active';
}

function resolveDateRange(query: MemberSpendQuery): { from: string; to: string } {
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [y, m] = query.month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      from: `${query.month}-01`,
      to: `${query.month}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  const to = query.to ?? new Date().toISOString().slice(0, 10);
  const from =
    query.from ??
    new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

function emptyFilters() {
  return {
    teams: [] as string[],
    users: [] as string[],
    utilizationStatuses: [] as string[],
    models: [] as string[],
    editors: [] as string[],
    languages: [] as string[],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

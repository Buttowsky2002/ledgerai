import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorSecretsService } from '../connectors/connector-secrets.service';
import { GitHubCopilotClient, GitHubCopilotApiError } from './github-copilot-client';
import {
  calculateMemberDailySpend,
  usageScore,
  type MemberDailyUsage,
  type MemberSeatInfo,
  type OrgDailyOverage,
} from './github-copilot-member-spend';
import { calculateCopilotRoi, mergeRoiAssumptions } from './github-copilot-roi';
import {
  CopilotMemberRow,
  CopilotRoiAssumptions,
  CopilotUsageRow,
  DEFAULT_SEAT_PRICE_USD,
} from './github-copilot.types';

export interface SyncResult {
  ok: boolean;
  seatsImported: number;
  membersImported: number;
  teamLinksImported: number;
  usageRowsImported: number;
  roiRowsComputed: number;
  memberSpendRowsComputed: number;
  errorCode?: string;
  errorMessage?: string;
}

@Injectable()
export class GitHubCopilotSyncService {
  private readonly logger = new Logger(GitHubCopilotSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ConnectorSecretsService,
  ) {}

  async syncConnection(connectionId: string, tenantId: string): Promise<SyncResult> {
    const conn = await this.prisma.withTenant(tenantId, (tx) =>
      tx.aiProviderConnection.findUnique({ where: { connectionId } }),
    );
    if (!conn) {
      return emptySyncResult(false, 'not_found', 'Connection not found');
    }

    const connector = await this.prisma.withTenant(tenantId, (tx) =>
      tx.connector.findUnique({ where: { connectorId: conn.connectorId } }),
    );
    if (!connector?.secretRef) {
      return emptySyncResult(false, 'no_token', 'GitHub token not configured');
    }

    const token = await this.secrets.resolveSecret(connector.secretRef);
    if (!token) {
      return emptySyncResult(false, 'no_token', 'Could not decrypt GitHub token');
    }

    const assumptions = mergeRoiAssumptions(conn.roiAssumptions as Partial<CopilotRoiAssumptions>);
    const client = new GitHubCopilotClient({
      token,
      orgSlug: conn.orgSlug,
      enterpriseSlug: conn.enterpriseSlug ?? undefined,
    });

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.connector.update({
        where: { connectorId: conn.connectorId },
        data: { status: 'syncing', lastSyncStartedAt: new Date() },
      }),
    );

    let seatsImported = 0;
    let membersImported = 0;
    let teamLinksImported = 0;
    let usageRowsImported = 0;
    let roiRowsComputed = 0;
    let memberSpendRowsComputed = 0;

    try {
      try {
        await client.fetchBilling();
      } catch (err) {
        this.logger.warn(`copilot billing sync skipped: ${safeMsg(err)}`);
      }

      const seats = await client.fetchAllSeats();
      seatsImported = await this.upsertSeats(tenantId, conn.connectionId, conn.orgSlug, seats);

      try {
        const members = await client.fetchMembersDetailed();
        membersImported = await this.upsertMembers(
          tenantId,
          conn.connectionId,
          conn.orgSlug,
          members,
        );
      } catch (err) {
        this.logger.warn(`org members sync skipped: ${safeMsg(err)}`);
      }

      try {
        const teams = await client.fetchTeams();
        teamLinksImported = await this.upsertTeamMemberships(
          tenantId,
          conn.connectionId,
          conn.orgSlug,
          teams,
          client,
        );
      } catch (err) {
        this.logger.warn(`team membership sync skipped: ${safeMsg(err)}`);
      }

      const usageRows: CopilotUsageRow[] = [];
      try {
        usageRows.push(...(await client.fetchOrg28DayUsage()));
      } catch (err) {
        this.logger.warn(`organization-28-day sync skipped: ${safeMsg(err)}`);
      }
      try {
        usageRows.push(...(await client.fetchUsers28DayUsage()));
      } catch (err) {
        this.logger.warn(`users-28-day sync skipped: ${safeMsg(err)}`);
      }

      for (let d = 0; d < 28; d++) {
        const day = new Date();
        day.setUTCDate(day.getUTCDate() - d);
        const dayStr = day.toISOString().slice(0, 10);
        try {
          const daily = await client.fetchUsers1DayUsage(dayStr);
          usageRows.push(...daily);
        } catch (err) {
          if (err instanceof GitHubCopilotApiError && err.status === 404) continue;
          this.logger.warn(`users-1-day sync skipped for ${dayStr}: ${safeMsg(err)}`);
        }
      }

      usageRowsImported = await this.upsertUsage(tenantId, conn.connectionId, conn.orgSlug, usageRows);
      roiRowsComputed = await this.computeRoiDaily(tenantId, conn.connectionId, conn.orgSlug, assumptions);
      memberSpendRowsComputed = await this.computeMemberSpendDaily(
        tenantId,
        conn.connectionId,
        conn.orgSlug,
        assumptions,
      );

      const totalRecords =
        seatsImported +
        membersImported +
        teamLinksImported +
        usageRowsImported +
        roiRowsComputed +
        memberSpendRowsComputed;

      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.aiProviderConnection.update({
          where: { connectionId },
          data: {
            lastSuccessAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
            recordsImported: totalRecords,
            updatedAt: new Date(),
          },
        });
        await tx.connector.update({
          where: { connectorId: conn.connectorId },
          data: {
            status: 'connected',
            lastSyncAt: new Date(),
            lastSyncCompletedAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
            lastErrorCode: null,
            lastErrorMessageSafe: null,
          },
        });
      });

      return {
        ok: true,
        seatsImported,
        membersImported,
        teamLinksImported,
        usageRowsImported,
        roiRowsComputed,
        memberSpendRowsComputed,
      };
    } catch (err) {
      const apiErr = err instanceof GitHubCopilotApiError ? err : null;
      const errorCode = apiErr?.code ?? 'sync_failed';
      const errorMessage = apiErr?.hint ?? apiErr?.message ?? safeMsg(err);

      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.aiProviderConnection.update({
          where: { connectionId },
          data: {
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
            updatedAt: new Date(),
          },
        });
        await tx.connector.update({
          where: { connectorId: conn.connectorId },
          data: {
            status: 'error',
            lastError: errorMessage,
            lastErrorCode: errorCode,
            lastErrorMessageSafe: errorMessage,
            lastSyncCompletedAt: new Date(),
          },
        });
      });

      return {
        ok: false,
        seatsImported,
        membersImported,
        teamLinksImported,
        usageRowsImported,
        roiRowsComputed,
        memberSpendRowsComputed,
        errorCode,
        errorMessage,
      };
    }
  }

  private async upsertSeats(
    tenantId: string,
    connectionId: string,
    orgSlug: string,
    seats: Awaited<ReturnType<GitHubCopilotClient['fetchAllSeats']>>,
  ): Promise<number> {
    let count = 0;
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const s of seats) {
        if (!s.githubUserId || !s.githubLogin) continue;
        await tx.githubCopilotSeat.upsert({
          where: {
            tenantId_connectionId_githubUserId: {
              tenantId,
              connectionId,
              githubUserId: BigInt(s.githubUserId),
            },
          },
          create: {
            tenantId,
            connectionId,
            orgSlug,
            githubUserId: BigInt(s.githubUserId),
            githubLogin: s.githubLogin,
            planType: s.planType,
            assigningTeamSlug: s.assigningTeamSlug,
            seatCreatedAt: s.seatCreatedAt,
            pendingCancellationDate: s.pendingCancellationDate,
            lastActivityAt: s.lastActivityAt,
            lastActivityEditor: s.lastActivityEditor,
            isActive: s.isActive,
            monthlySeatCost: s.monthlySeatCost ?? DEFAULT_SEAT_PRICE_USD,
            rawPayload: (s.rawPayload ?? {}) as Prisma.InputJsonValue,
            syncedAt: new Date(),
          },
          update: {
            githubLogin: s.githubLogin,
            planType: s.planType,
            assigningTeamSlug: s.assigningTeamSlug,
            seatCreatedAt: s.seatCreatedAt,
            pendingCancellationDate: s.pendingCancellationDate,
            lastActivityAt: s.lastActivityAt,
            lastActivityEditor: s.lastActivityEditor,
            isActive: s.isActive,
            monthlySeatCost: s.monthlySeatCost ?? DEFAULT_SEAT_PRICE_USD,
            rawPayload: (s.rawPayload ?? {}) as Prisma.InputJsonValue,
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        count += 1;
      }
    });
    return count;
  }

  private async upsertUsage(
    tenantId: string,
    connectionId: string,
    orgSlug: string,
    rows: CopilotUsageRow[],
  ): Promise<number> {
    let count = 0;
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const r of rows) {
        const usageDate = new Date(`${r.usageDate}T00:00:00.000Z`);
        await tx.githubCopilotUsageDaily.upsert({
          where: {
            tenantId_connectionId_usageDate_githubLogin_teamSlug_editor_language_model_feature: {
              tenantId,
              connectionId,
              usageDate,
              githubLogin: r.githubLogin,
              teamSlug: r.teamSlug,
              editor: r.editor,
              language: r.language,
              model: r.model,
              feature: r.feature,
            },
          },
          create: {
            tenantId,
            connectionId,
            orgSlug,
            usageDate,
            githubLogin: r.githubLogin,
            teamSlug: r.teamSlug,
            editor: r.editor,
            language: r.language,
            model: r.model,
            feature: r.feature,
            suggestionsCount: r.suggestionsCount,
            acceptancesCount: r.acceptancesCount,
            linesSuggested: r.linesSuggested,
            linesAccepted: r.linesAccepted,
            activeUsers: r.activeUsers,
            engagedUsers: r.engagedUsers,
            chatTurns: r.chatTurns,
            prSummaryCount: r.prSummaryCount,
            aiCreditsUsed: r.aiCreditsUsed,
            rawPayload: r.rawPayload as Prisma.InputJsonValue,
            syncedAt: new Date(),
          },
          update: {
            suggestionsCount: r.suggestionsCount,
            acceptancesCount: r.acceptancesCount,
            linesSuggested: r.linesSuggested,
            linesAccepted: r.linesAccepted,
            activeUsers: r.activeUsers,
            engagedUsers: r.engagedUsers,
            chatTurns: r.chatTurns,
            prSummaryCount: r.prSummaryCount,
            aiCreditsUsed: r.aiCreditsUsed,
            rawPayload: r.rawPayload as Prisma.InputJsonValue,
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        count += 1;
      }
    });
    return count;
  }

  private async computeRoiDaily(
    tenantId: string,
    connectionId: string,
    orgSlug: string,
    assumptions: CopilotRoiAssumptions,
  ): Promise<number> {
    const seats = await this.prisma.withTenant(tenantId, (tx) =>
      tx.githubCopilotSeat.findMany({ where: { tenantId, connectionId } }),
    );
    const usage = await this.prisma.withTenant(tenantId, (tx) =>
      tx.githubCopilotUsageDaily.findMany({ where: { tenantId, connectionId } }),
    );

    const byDateTeam = new Map<
      string,
      {
        teamSlug: string;
        usageDate: string;
        linesAccepted: number;
        chatTurns: number;
        prSummaryCount: number;
        aiCreditsUsed: number;
        activeUsers: number;
        engagedUsers: number;
      }
    >();

    for (const u of usage) {
      const day = u.usageDate.toISOString().slice(0, 10);
      const team = u.teamSlug || '';
      const key = `${day}|${team}`;
      const cur = byDateTeam.get(key) ?? {
        teamSlug: team,
        usageDate: day,
        linesAccepted: 0,
        chatTurns: 0,
        prSummaryCount: 0,
        aiCreditsUsed: 0,
        activeUsers: 0,
        engagedUsers: 0,
      };
      cur.linesAccepted += u.linesAccepted;
      cur.chatTurns += u.chatTurns;
      cur.prSummaryCount += u.prSummaryCount;
      cur.aiCreditsUsed += Number(u.aiCreditsUsed);
      cur.activeUsers = Math.max(cur.activeUsers, u.activeUsers);
      cur.engagedUsers = Math.max(cur.engagedUsers, u.engagedUsers);
      byDateTeam.set(key, cur);
    }

    const teamSeatCounts = new Map<string, { assigned: number; active: number }>();
    for (const s of seats) {
      const team = s.assigningTeamSlug ?? '';
      const cur = teamSeatCounts.get(team) ?? { assigned: 0, active: 0 };
      cur.assigned += 1;
      if (s.isActive && s.lastActivityAt) {
        const days = (Date.now() - s.lastActivityAt.getTime()) / 86_400_000;
        if (days <= 28) cur.active += 1;
      }
      teamSeatCounts.set(team, cur);
    }

    if (byDateTeam.size === 0 && seats.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      byDateTeam.set(`${today}|`, {
        teamSlug: '',
        usageDate: today,
        linesAccepted: 0,
        chatTurns: 0,
        prSummaryCount: 0,
        aiCreditsUsed: 0,
        activeUsers: 0,
        engagedUsers: 0,
      });
    }

    let count = 0;
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const agg of byDateTeam.values()) {
        const seatInfo = teamSeatCounts.get(agg.teamSlug) ?? {
          assigned: seats.length,
          active: seats.filter((s) => s.isActive).length,
        };
        const roi = calculateCopilotRoi({
          assignedSeats: seatInfo.assigned,
          activeSeats: seatInfo.active,
          aiCreditsUsed: agg.aiCreditsUsed,
          linesAccepted: agg.linesAccepted,
          chatTurns: agg.chatTurns,
          prSummaryCount: agg.prSummaryCount,
          assumptions,
        });

        const usageDate = new Date(`${agg.usageDate}T00:00:00.000Z`);
        await tx.githubCopilotRoiDaily.upsert({
          where: {
            tenantId_connectionId_usageDate_teamSlug: {
              tenantId,
              connectionId,
              usageDate,
              teamSlug: agg.teamSlug,
            },
          },
          create: {
            tenantId,
            connectionId,
            orgSlug,
            usageDate,
            teamSlug: agg.teamSlug,
            assignedSeats: roi.assignedSeats,
            activeSeats: roi.activeSeats,
            baseSeatCost: roi.baseSeatCost,
            includedAiCredits: roi.includedAiCredits,
            aiCreditsUsed: roi.aiCreditsUsed,
            overageEstimate: roi.overageEstimate,
            totalCopilotCost: roi.totalCopilotCost,
            linesAccepted: roi.linesAccepted,
            chatTurns: roi.chatTurns,
            prSummaryCount: roi.prSummaryCount,
            grossHoursSaved: roi.grossHoursSaved,
            adjustedHoursSaved: roi.adjustedHoursSaved,
            estimatedValue: roi.estimatedValue,
            roiPercentage: roi.roiPercentage,
            assumptionsSnapshot: assumptions as unknown as Prisma.InputJsonValue,
          },
          update: {
            assignedSeats: roi.assignedSeats,
            activeSeats: roi.activeSeats,
            baseSeatCost: roi.baseSeatCost,
            includedAiCredits: roi.includedAiCredits,
            aiCreditsUsed: roi.aiCreditsUsed,
            overageEstimate: roi.overageEstimate,
            totalCopilotCost: roi.totalCopilotCost,
            linesAccepted: roi.linesAccepted,
            chatTurns: roi.chatTurns,
            prSummaryCount: roi.prSummaryCount,
            grossHoursSaved: roi.grossHoursSaved,
            adjustedHoursSaved: roi.adjustedHoursSaved,
            estimatedValue: roi.estimatedValue,
            roiPercentage: roi.roiPercentage,
            assumptionsSnapshot: assumptions as unknown as Prisma.InputJsonValue,
            updatedAt: new Date(),
          },
        });
        count += 1;
      }
    });
    return count;
  }

  private async upsertMembers(
    tenantId: string,
    connectionId: string,
    orgSlug: string,
    members: CopilotMemberRow[],
  ): Promise<number> {
    let count = 0;
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const m of members) {
        await tx.githubCopilotMember.upsert({
          where: {
            tenantId_connectionId_githubUserId: {
              tenantId,
              connectionId,
              githubUserId: BigInt(m.githubUserId),
            },
          },
          create: {
            tenantId,
            connectionId,
            orgSlug,
            githubUserId: BigInt(m.githubUserId),
            githubLogin: m.githubLogin,
            displayName: m.displayName,
            email: m.email,
            avatarUrl: m.avatarUrl,
            role: m.role,
            isOrgMember: m.isOrgMember,
            syncedAt: new Date(),
          },
          update: {
            githubLogin: m.githubLogin,
            displayName: m.displayName,
            email: m.email,
            avatarUrl: m.avatarUrl,
            role: m.role,
            isOrgMember: m.isOrgMember,
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        count += 1;
      }
    });
    return count;
  }

  private async upsertTeamMemberships(
    tenantId: string,
    connectionId: string,
    orgSlug: string,
    teams: { slug: string; name: string }[],
    client: GitHubCopilotClient,
  ): Promise<number> {
    let count = 0;
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const team of teams) {
        let members: { id: number; login: string }[];
        try {
          members = await client.fetchTeamMembers(team.slug);
        } catch (err) {
          this.logger.warn(`team ${team.slug} members skipped: ${safeMsg(err)}`);
          continue;
        }
        for (const m of members) {
          await tx.githubCopilotMemberTeam.upsert({
            where: {
              tenantId_connectionId_githubLogin_teamSlug: {
                tenantId,
                connectionId,
                githubLogin: m.login,
                teamSlug: team.slug,
              },
            },
            create: {
              tenantId,
              connectionId,
              orgSlug,
              githubLogin: m.login,
              teamSlug: team.slug,
              teamName: team.name,
              syncedAt: new Date(),
            },
            update: {
              teamName: team.name,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
          count += 1;
        }
      }
    });
    return count;
  }

  private async computeMemberSpendDaily(
    tenantId: string,
    connectionId: string,
    orgSlug: string,
    assumptions: CopilotRoiAssumptions,
  ): Promise<number> {
    const [seats, usage, roiRows, memberTeams] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotSeat.findMany({ where: { tenantId, connectionId } }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotUsageDaily.findMany({
          where: { tenantId, connectionId },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotRoiDaily.findMany({
          where: { tenantId, connectionId, teamSlug: '' },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.githubCopilotMemberTeam.findMany({ where: { tenantId, connectionId } }),
      ),
    ]);

    const seatByLogin = new Map<string, MemberSeatInfo>();
    for (const s of seats) {
      seatByLogin.set(s.githubLogin, {
        githubLogin: s.githubLogin,
        monthlySeatCost: Number(s.monthlySeatCost),
        lastActivityAt: s.lastActivityAt,
        isActive: s.isActive,
        assigningTeamSlug: s.assigningTeamSlug,
      });
    }

    const primaryTeamByLogin = new Map<string, string>();
    for (const mt of memberTeams) {
      if (!primaryTeamByLogin.has(mt.githubLogin)) {
        primaryTeamByLogin.set(mt.githubLogin, mt.teamSlug);
      }
    }
    for (const s of seats) {
      if (s.assigningTeamSlug && !primaryTeamByLogin.has(s.githubLogin)) {
        primaryTeamByLogin.set(s.githubLogin, s.assigningTeamSlug);
      }
    }

    const overageByDay = new Map<string, OrgDailyOverage>();
    for (const r of roiRows) {
      const day = r.usageDate.toISOString().slice(0, 10);
      const cur = overageByDay.get(day) ?? {
        usageDate: day,
        totalOverageCost: 0,
        totalOrgAiCreditsUsed: 0,
      };
      cur.totalOverageCost += Number(r.overageEstimate);
      cur.totalOrgAiCreditsUsed += Number(r.aiCreditsUsed);
      overageByDay.set(day, cur);
    }

    const usageByLoginDay = new Map<string, MemberDailyUsage>();
    for (const u of usage) {
      if (!u.githubLogin) continue;
      const day = u.usageDate.toISOString().slice(0, 10);
      const teamSlug = primaryTeamByLogin.get(u.githubLogin) ?? u.teamSlug ?? '';
      const key = `${day}|${u.githubLogin}`;
      const cur = usageByLoginDay.get(key) ?? {
        githubLogin: u.githubLogin,
        teamSlug,
        usageDate: day,
        aiCreditsUsed: 0,
        linesAccepted: 0,
        chatTurns: 0,
        prSummaryCount: 0,
      };
      cur.aiCreditsUsed += Number(u.aiCreditsUsed);
      cur.linesAccepted += u.linesAccepted;
      cur.chatTurns += u.chatTurns;
      cur.prSummaryCount += u.prSummaryCount;
      usageByLoginDay.set(key, cur);
    }

    // Backfill every active seat for each day we have org usage/ROI data so member
    // totals reconcile with org-level allocated spend (seat cost applies daily per seat).
    const allDays = new Set<string>();
    for (const u of usage) {
      allDays.add(u.usageDate.toISOString().slice(0, 10));
    }
    for (const r of roiRows) {
      allDays.add(r.usageDate.toISOString().slice(0, 10));
    }
    if (allDays.size === 0) {
      for (let d = 0; d < 28; d++) {
        const day = new Date();
        day.setUTCDate(day.getUTCDate() - d);
        allDays.add(day.toISOString().slice(0, 10));
      }
    }

    for (const day of allDays) {
      for (const s of seats) {
        if (!s.isActive) continue;
        const key = `${day}|${s.githubLogin}`;
        if (!usageByLoginDay.has(key)) {
          usageByLoginDay.set(key, {
            githubLogin: s.githubLogin,
            teamSlug: primaryTeamByLogin.get(s.githubLogin) ?? s.assigningTeamSlug ?? '',
            usageDate: day,
            aiCreditsUsed: 0,
            linesAccepted: 0,
            chatTurns: 0,
            prSummaryCount: 0,
          });
        }
      }
    }

    const byDay = new Map<string, MemberDailyUsage[]>();
    for (const u of usageByLoginDay.values()) {
      const list = byDay.get(u.usageDate) ?? [];
      list.push(u);
      byDay.set(u.usageDate, list);
    }

    let count = 0;
    const now = new Date();
    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const [day, dayUsage] of byDay) {
        const peerUsage = dayUsage.map((u) => ({
          githubLogin: u.githubLogin,
          score: usageScore(u),
        }));
        const orgOverage = overageByDay.get(day);

        for (const u of dayUsage) {
          const seat = seatByLogin.get(u.githubLogin);
          const result = calculateMemberDailySpend({
            usage: u,
            seat,
            orgOverage,
            assumptions,
            peerUsage,
            now,
          });

          const usageDate = new Date(`${u.usageDate}T00:00:00.000Z`);
          await tx.githubCopilotMemberSpendDaily.upsert({
            where: {
              tenantId_connectionId_usageDate_githubLogin_teamSlug: {
                tenantId,
                connectionId,
                usageDate,
                githubLogin: u.githubLogin,
                teamSlug: u.teamSlug,
              },
            },
            create: {
              tenantId,
              connectionId,
              orgSlug,
              usageDate,
              githubLogin: u.githubLogin,
              teamSlug: u.teamSlug,
              seatCost: result.seatCost,
              estimatedCreditCost: result.estimatedCreditCost,
              allocatedOverageCost: result.allocatedOverageCost,
              totalAllocatedCost: result.totalAllocatedCost,
              aiCreditsUsed: result.aiCreditsUsed,
              linesAccepted: result.linesAccepted,
              chatTurns: result.chatTurns,
              prSummaryCount: result.prSummaryCount,
              estimatedHoursSaved: result.estimatedHoursSaved,
              estimatedValueCreated: result.estimatedValueCreated,
              roiPercentage: result.roiPercentage,
              utilizationStatus: result.utilizationStatus,
              confidenceScore: result.confidenceScore,
              calculationVersion: 'v1',
            },
            update: {
              seatCost: result.seatCost,
              estimatedCreditCost: result.estimatedCreditCost,
              allocatedOverageCost: result.allocatedOverageCost,
              totalAllocatedCost: result.totalAllocatedCost,
              aiCreditsUsed: result.aiCreditsUsed,
              linesAccepted: result.linesAccepted,
              chatTurns: result.chatTurns,
              prSummaryCount: result.prSummaryCount,
              estimatedHoursSaved: result.estimatedHoursSaved,
              estimatedValueCreated: result.estimatedValueCreated,
              roiPercentage: result.roiPercentage,
              utilizationStatus: result.utilizationStatus,
              confidenceScore: result.confidenceScore,
              updatedAt: new Date(),
            },
          });
          count += 1;
        }
      }
    });
    return count;
  }
}

function emptySyncResult(ok: boolean, errorCode: string, errorMessage: string): SyncResult {
  return {
    ok,
    seatsImported: 0,
    membersImported: 0,
    teamLinksImported: 0,
    usageRowsImported: 0,
    roiRowsComputed: 0,
    memberSpendRowsComputed: 0,
    errorCode,
    errorMessage,
  };
}

function safeMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown sync error';
}

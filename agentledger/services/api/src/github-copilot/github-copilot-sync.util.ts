import { Prisma } from '@prisma/client';

import type {
  MemberDailyUsage,
  MemberSeatInfo,
  OrgDailyOverage,
} from './github-copilot-member-spend';

// Pure in-memory aggregation transforms extracted verbatim from
// GitHubCopilotSyncService. The sync service keeps the Prisma reads/upserts and
// GitHub API calls; these functions only reshape already-fetched rows into the
// intermediate maps the upsert phase iterates, so they are unit-testable without
// a database. Inputs are declared structurally (the subset of each Prisma row
// actually read) to keep this module free of persistence concerns.

type Decimalish = Prisma.Decimal | number;

/** ROI-daily aggregate keyed by `${day}|${teamSlug}`, summed across usage rows. */
export interface RoiDayTeamAggregate {
  teamSlug: string;
  usageDate: string;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  aiCreditsUsed: number;
  activeUsers: number;
  engagedUsers: number;
}

export interface RoiUsageInput {
  usageDate: Date;
  teamSlug: string | null;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  aiCreditsUsed: Decimalish;
  activeUsers: number;
  engagedUsers: number;
}

export interface RoiSeatInput {
  assigningTeamSlug: string | null;
  isActive: boolean;
  lastActivityAt: Date | null;
}

export function buildRoiDayTeamAggregates(
  usage: RoiUsageInput[],
  seatsCount: number,
): Map<string, RoiDayTeamAggregate> {
  const byDateTeam = new Map<string, RoiDayTeamAggregate>();

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

  if (byDateTeam.size === 0 && seatsCount > 0) {
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

  return byDateTeam;
}

export function buildTeamSeatCounts(
  seats: RoiSeatInput[],
  nowMs: number,
): Map<string, { assigned: number; active: number }> {
  const teamSeatCounts = new Map<string, { assigned: number; active: number }>();
  for (const s of seats) {
    const team = s.assigningTeamSlug ?? '';
    const cur = teamSeatCounts.get(team) ?? { assigned: 0, active: 0 };
    cur.assigned += 1;
    if (s.isActive && s.lastActivityAt) {
      const days = (nowMs - s.lastActivityAt.getTime()) / 86_400_000;
      if (days <= 28) {
        cur.active += 1;
      }
    }
    teamSeatCounts.set(team, cur);
  }
  return teamSeatCounts;
}

export interface MemberSpendSeatInput {
  githubLogin: string;
  monthlySeatCost: Decimalish;
  lastActivityAt: Date | null;
  isActive: boolean;
  assigningTeamSlug: string | null;
}

export interface MemberSpendUsageInput {
  githubLogin: string;
  usageDate: Date;
  teamSlug: string | null;
  aiCreditsUsed: Decimalish;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
}

export interface MemberSpendRoiInput {
  usageDate: Date;
  overageEstimate: Decimalish;
  aiCreditsUsed: Decimalish;
}

export interface MemberSpendTeamInput {
  githubLogin: string;
  teamSlug: string;
}

export interface MemberSpendAggregates {
  seatByLogin: Map<string, MemberSeatInfo>;
  overageByDay: Map<string, OrgDailyOverage>;
  byDay: Map<string, MemberDailyUsage[]>;
}

/**
 * Build the per-day, per-member usage lists (plus seat and org-overage lookups)
 * that computeMemberSpendDaily's upsert loop consumes. Backfills active seats onto
 * every observed day so member totals reconcile with org-level allocated spend.
 */
export function buildMemberSpendAggregates(input: {
  seats: MemberSpendSeatInput[];
  usage: MemberSpendUsageInput[];
  roiRows: MemberSpendRoiInput[];
  memberTeams: MemberSpendTeamInput[];
}): MemberSpendAggregates {
  const { seats, usage, roiRows, memberTeams } = input;

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
    if (!u.githubLogin) {
      continue;
    }
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
      if (!s.isActive) {
        continue;
      }
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

  return { seatByLogin, overageByDay, byDay };
}

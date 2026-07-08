import { CopilotRoiAssumptions, DEFAULT_SEAT_PRICE_USD } from './github-copilot.types';

export type UtilizationStatus =
  | 'inactive'
  | 'low_usage'
  | 'active'
  | 'high_usage'
  | 'high_roi'
  | 'negative_roi';

export interface MemberDailyUsage {
  githubLogin: string;
  teamSlug: string;
  usageDate: string;
  aiCreditsUsed: number;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
}

export interface MemberSeatInfo {
  githubLogin: string;
  monthlySeatCost: number;
  lastActivityAt?: Date | null;
  isActive: boolean;
  assigningTeamSlug?: string | null;
}

export interface OrgDailyOverage {
  usageDate: string;
  totalOverageCost: number;
  totalOrgAiCreditsUsed: number;
}

export interface MemberDailySpendInput {
  usage: MemberDailyUsage;
  seat?: MemberSeatInfo;
  orgOverage?: OrgDailyOverage;
  assumptions: CopilotRoiAssumptions;
  /** For high_usage classification within a day cohort */
  peerUsage?: { githubLogin: string; score: number }[];
  now?: Date;
}

export interface MemberDailySpendResult {
  githubLogin: string;
  teamSlug: string;
  usageDate: string;
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
  roiPercentage: number | null;
  utilizationStatus: UtilizationStatus;
  confidenceScore: number;
}

/** Days in the calendar month containing `isoDate` (YYYY-MM-DD). */
export function daysInMonth(isoDate: string): number {
  const [y, m] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Daily prorated seat cost for a paid active seat. */
export function dailySeatCost(monthlySeatCost: number, isoDate: string): number {
  const dim = daysInMonth(isoDate);
  return dim > 0 ? monthlySeatCost / dim : monthlySeatCost / 30;
}

/** Estimated credit cost at configured credit price — allocated, not invoice. */
export function estimatedCreditCost(aiCreditsUsed: number, creditPriceUsd: number): number {
  return Math.max(0, aiCreditsUsed) * creditPriceUsd;
}

/** Proportional org overage allocation by AI credit share. */
export function allocatedOverageCost(
  userAiCredits: number,
  totalOrgAiCredits: number,
  totalOrgOverageCost: number,
): number {
  if (totalOrgOverageCost <= 0 || totalOrgAiCredits <= 0 || userAiCredits <= 0) return 0;
  return totalOrgOverageCost * (userAiCredits / totalOrgAiCredits);
}

export interface MemberRoiInput {
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  totalAllocatedCost: number;
  assumptions: CopilotRoiAssumptions;
}

export interface MemberRoiResult {
  estimatedHoursSaved: number;
  estimatedValueCreated: number;
  roiPercentage: number | null;
}

/** Member-level ROI from usage metrics and allocated cost — all estimates. */
export function calculateMemberRoi(input: MemberRoiInput): MemberRoiResult {
  const a = input.assumptions;
  const completionMinutes = input.linesAccepted * a.minutesSavedPerAcceptedLine;
  const chatMinutes = input.chatTurns * a.minutesSavedPerChatTurn;
  const prMinutes = input.prSummaryCount * a.minutesSavedPerPrSummary;
  const grossHours = (completionMinutes + chatMinutes + prMinutes) / 60;
  const estimatedHoursSaved = grossHours * a.qualityAdjustmentFactor;
  const estimatedValueCreated = estimatedHoursSaved * a.avgEngineerHourlyRate;
  const cost = input.totalAllocatedCost;
  const roiPercentage =
    cost > 0 ? ((estimatedValueCreated - cost) / cost) * 100 : null;
  return {
    estimatedHoursSaved: round4(estimatedHoursSaved),
    estimatedValueCreated: round2(estimatedValueCreated),
    roiPercentage: roiPercentage != null ? round2(roiPercentage) : null,
  };
}

export function usageScore(u: Pick<MemberDailyUsage, 'aiCreditsUsed' | 'chatTurns' | 'linesAccepted'>): number {
  return u.aiCreditsUsed + u.chatTurns + u.linesAccepted;
}

export function isInactiveSeat(
  seat: MemberSeatInfo | undefined,
  usageInPeriod: number,
  inactiveDaysThreshold: number,
  now: Date,
): boolean {
  if (!seat?.isActive) return false;
  if (!seat.lastActivityAt && usageInPeriod === 0) return true;
  if (!seat.lastActivityAt) return usageInPeriod === 0;
  const days = (now.getTime() - seat.lastActivityAt.getTime()) / 86_400_000;
  return days >= inactiveDaysThreshold && usageInPeriod === 0;
}

export function isLowUsageSeat(
  seat: MemberSeatInfo | undefined,
  usageInPeriod: number,
  lowUsageDaysThreshold: number,
  now: Date,
): boolean {
  if (!seat?.isActive || usageInPeriod > 5) return false;
  if (!seat.lastActivityAt) return true;
  const days = (now.getTime() - seat.lastActivityAt.getTime()) / 86_400_000;
  return days >= lowUsageDaysThreshold;
}

export function isHighUsage(
  login: string,
  score: number,
  peerScores: { githubLogin: string; score: number }[],
): boolean {
  if (peerScores.length < 5) return false;
  const sorted = [...peerScores].sort((a, b) => b.score - a.score);
  const cutoffIdx = Math.max(0, Math.floor(sorted.length * 0.2) - 1);
  const threshold = sorted[cutoffIdx]?.score ?? 0;
  return score >= threshold && score > 0;
}

export function resolveUtilizationStatus(args: {
  seat?: MemberSeatInfo;
  usageInPeriod: number;
  roiPercentage: number | null;
  score: number;
  peerScores: { githubLogin: string; score: number }[];
  assumptions: CopilotRoiAssumptions;
  now: Date;
}): UtilizationStatus {
  const inactiveThreshold = args.assumptions.inactiveDaysThreshold ?? 30;
  const lowUsageThreshold = args.assumptions.lowUsageDaysThreshold ?? 14;
  const highRoiThreshold = args.assumptions.highRoiThreshold ?? 100;

  if (isInactiveSeat(args.seat, args.usageInPeriod, inactiveThreshold, args.now)) {
    return 'inactive';
  }
  if (args.roiPercentage != null && args.roiPercentage < 0 && args.usageInPeriod > 0) {
    return 'negative_roi';
  }
  if (isLowUsageSeat(args.seat, args.usageInPeriod, lowUsageThreshold, args.now)) {
    return 'low_usage';
  }
  if (args.roiPercentage != null && args.roiPercentage >= highRoiThreshold) {
    return 'high_roi';
  }
  if (isHighUsage(args.score > 0 ? 'x' : '', args.score, args.peerScores)) {
    return 'high_usage';
  }
  return 'active';
}

/** Seat-only day when invoice credit for the month is already on the billing row. */
export function calculateMemberDailySpendSeatOnly(
  input: MemberDailySpendInput,
): MemberDailySpendResult {
  const { usage, seat, assumptions } = input;
  const now = input.now ?? new Date();
  const monthlyCost = seat?.isActive ? (seat.monthlySeatCost ?? DEFAULT_SEAT_PRICE_USD) : 0;
  const seatCost = seat?.isActive ? dailySeatCost(monthlyCost, usage.usageDate) : 0;

  const roi = calculateMemberRoi({
    linesAccepted: usage.linesAccepted,
    chatTurns: usage.chatTurns,
    prSummaryCount: usage.prSummaryCount,
    totalAllocatedCost: seatCost,
    assumptions,
  });

  const score = usageScore(usage);
  const peerScores = input.peerUsage ?? [];
  const utilizationStatus = resolveUtilizationStatus({
    seat,
    usageInPeriod: score,
    roiPercentage: roi.roiPercentage,
    score,
    peerScores,
    assumptions,
    now,
  });

  return {
    githubLogin: usage.githubLogin,
    teamSlug: usage.teamSlug,
    usageDate: usage.usageDate,
    seatCost: round2(seatCost),
    estimatedCreditCost: 0,
    allocatedOverageCost: 0,
    totalAllocatedCost: round2(seatCost),
    aiCreditsUsed: round2(usage.aiCreditsUsed),
    linesAccepted: usage.linesAccepted,
    chatTurns: usage.chatTurns,
    prSummaryCount: usage.prSummaryCount,
    estimatedHoursSaved: roi.estimatedHoursSaved,
    estimatedValueCreated: roi.estimatedValueCreated,
    roiPercentage: roi.roiPercentage,
    utilizationStatus,
    confidenceScore: 0.98,
  };
}

/** Compute one member-day allocated spend row. */
export function calculateMemberDailySpend(input: MemberDailySpendInput): MemberDailySpendResult {
  const { usage, seat, orgOverage, assumptions } = input;
  const now = input.now ?? new Date();
  const monthlyCost = seat?.isActive ? (seat.monthlySeatCost ?? DEFAULT_SEAT_PRICE_USD) : 0;
  const seatCost = seat?.isActive ? dailySeatCost(monthlyCost, usage.usageDate) : 0;
  const creditCost = estimatedCreditCost(usage.aiCreditsUsed, assumptions.creditValueUsd);
  const overage =
    orgOverage && orgOverage.totalOrgAiCreditsUsed > 0
      ? allocatedOverageCost(
          usage.aiCreditsUsed,
          orgOverage.totalOrgAiCreditsUsed,
          orgOverage.totalOverageCost,
        )
      : 0;
  const totalAllocatedCost = seatCost + creditCost + overage;

  const roi = calculateMemberRoi({
    linesAccepted: usage.linesAccepted,
    chatTurns: usage.chatTurns,
    prSummaryCount: usage.prSummaryCount,
    totalAllocatedCost,
    assumptions,
  });

  const score = usageScore(usage);
  const peerScores = input.peerUsage ?? [];
  const utilizationStatus = resolveUtilizationStatus({
    seat,
    usageInPeriod: score,
    roiPercentage: roi.roiPercentage,
    score,
    peerScores,
    assumptions,
    now,
  });

  return {
    githubLogin: usage.githubLogin,
    teamSlug: usage.teamSlug,
    usageDate: usage.usageDate,
    seatCost: round2(seatCost),
    estimatedCreditCost: round2(creditCost),
    allocatedOverageCost: round2(overage),
    totalAllocatedCost: round2(totalAllocatedCost),
    aiCreditsUsed: round2(usage.aiCreditsUsed),
    linesAccepted: usage.linesAccepted,
    chatTurns: usage.chatTurns,
    prSummaryCount: usage.prSummaryCount,
    estimatedHoursSaved: roi.estimatedHoursSaved,
    estimatedValueCreated: roi.estimatedValueCreated,
    roiPercentage: roi.roiPercentage,
    utilizationStatus,
    confidenceScore: 0.85,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

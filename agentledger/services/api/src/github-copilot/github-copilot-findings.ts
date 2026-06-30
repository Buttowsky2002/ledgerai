import {
  CopilotFinding,
  CopilotRoiAssumptions,
  DEFAULT_SEAT_PRICE_USD,
} from './github-copilot.types';

export interface SeatForFindings {
  githubLogin: string;
  assigningTeamSlug?: string | null;
  lastActivityAt?: Date | null;
  pendingCancellationDate?: Date | null;
  isActive: boolean;
  monthlySeatCost: number;
}

export interface UserUsageForFindings {
  githubLogin: string;
  teamSlug: string;
  aiCreditsUsed: number;
  linesAccepted: number;
  acceptancesCount: number;
}

export interface TeamRoiForFindings {
  teamSlug: string;
  roiPercentage: number;
  assignedSeats: number;
  activeSeats: number;
}

const MS_DAY = 86_400_000;

function daysSince(d: Date | null | undefined, now: Date): number {
  if (!d) return Infinity;
  return (now.getTime() - d.getTime()) / MS_DAY;
}

/** Automated Copilot findings — advisory only, not exact savings claims. */
export function generateCopilotFindings(args: {
  seats: SeatForFindings[];
  userUsage: UserUsageForFindings[];
  teamRoi: TeamRoiForFindings[];
  assumptions: CopilotRoiAssumptions;
  includedCreditsPerUser: number;
  now?: Date;
}): CopilotFinding[] {
  const now = args.now ?? new Date();
  const findings: CopilotFinding[] = [];
  const seatPrice = args.assumptions.seatPriceUsd ?? DEFAULT_SEAT_PRICE_USD;

  const inactive14 = args.seats.filter(
    (s) => s.isActive && daysSince(s.lastActivityAt, now) >= 14,
  );
  if (inactive14.length > 0) {
    const waste = inactive14.length * seatPrice;
    findings.push({
      id: 'seats-inactive-14d',
      severity: 'warning',
      category: 'seat_waste',
      title: 'Seats inactive 14+ days',
      message: `${inactive14.length} Copilot seat${inactive14.length === 1 ? '' : 's'} ha${inactive14.length === 1 ? 's' : 've'} had no activity in 14 days. Estimated wasted spend is $${waste.toFixed(0)}/month. Review usage before the next billing cycle.`,
      estimatedImpactUsd: waste,
      affectedCount: inactive14.length,
    });
  }

  const inactive30 = args.seats.filter(
    (s) => s.isActive && daysSince(s.lastActivityAt, now) >= 30,
  );
  if (inactive30.length > 0) {
    const waste = inactive30.length * seatPrice;
    findings.push({
      id: 'seats-inactive-30d',
      severity: 'critical',
      category: 'seat_waste',
      title: 'Seats inactive 30+ days',
      message: `${inactive30.length} Copilot seat${inactive30.length === 1 ? '' : 's'} ha${inactive30.length === 1 ? 's' : 've'} had no activity in 30 days. Estimated wasted spend is $${waste.toFixed(0)}/month. Review or remove before the next billing cycle.`,
      estimatedImpactUsd: waste,
      affectedCount: inactive30.length,
    });
  }

  const highCreditLowOutput = args.userUsage.filter(
    (u) =>
      u.aiCreditsUsed >= args.includedCreditsPerUser * 0.5 &&
      u.linesAccepted < 20 &&
      u.acceptancesCount < 30,
  );
  if (highCreditLowOutput.length > 0) {
    findings.push({
      id: 'high-credit-low-output',
      severity: 'warning',
      category: 'utilization',
      title: 'High credit usage, low accepted output',
      message: `${highCreditLowOutput.length} user${highCreditLowOutput.length === 1 ? '' : 's'} consumed substantial AI credits but show low accepted completions. Coach on effective prompt patterns or review seat assignment.`,
      affectedCount: highCreditLowOutput.length,
    });
  }

  const highRoiTeams = args.teamRoi.filter((t) => t.roiPercentage >= 100 && t.activeSeats >= 2);
  for (const t of highRoiTeams.slice(0, 3)) {
    findings.push({
      id: `high-roi-${t.teamSlug || 'org'}`,
      severity: 'info',
      category: 'roi',
      title: `Strong estimated ROI: ${t.teamSlug || 'Organization'}`,
      message: `Team "${t.teamSlug || 'Organization'}" shows estimated ROI of ${t.roiPercentage.toFixed(0)}%. Consider expanding Copilot adoption patterns from this team.`,
    });
  }

  const lowAdoptionTeams = args.teamRoi.filter(
    (t) => t.assignedSeats >= 3 && t.activeSeats / Math.max(t.assignedSeats, 1) < 0.4,
  );
  for (const t of lowAdoptionTeams.slice(0, 3)) {
    findings.push({
      id: `low-adoption-${t.teamSlug || 'org'}`,
      severity: 'warning',
      category: 'adoption',
      title: `Low adoption: ${t.teamSlug || 'Organization'}`,
      message: `Team "${t.teamSlug || 'Organization'}" has ${t.activeSeats} active seats of ${t.assignedSeats} assigned (${Math.round((t.activeSeats / t.assignedSeats) * 100)}% active). Run enablement or reallocate unused seats.`,
      affectedCount: t.assignedSeats - t.activeSeats,
    });
  }

  const nearCreditLimit = args.userUsage.filter(
    (u) => u.aiCreditsUsed >= args.includedCreditsPerUser * 0.85,
  );
  if (nearCreditLimit.length > 0) {
    findings.push({
      id: 'near-credit-allocation',
      severity: 'warning',
      category: 'credits',
      title: 'Users near included credit allocation',
      message: `${nearCreditLimit.length} user${nearCreditLimit.length === 1 ? '' : 's'} are at or above 85% of included monthly AI credits (${args.includedCreditsPerUser}/seat). Monitor for overage charges.`,
      affectedCount: nearCreditLimit.length,
    });
  }

  const pendingCancel = args.seats.filter((s) => s.pendingCancellationDate != null);
  if (pendingCancel.length > 0) {
    findings.push({
      id: 'seats-pending-cancellation',
      severity: 'info',
      category: 'billing',
      title: 'Seats pending cancellation',
      message: `${pendingCancel.length} seat${pendingCancel.length === 1 ? '' : 's'} scheduled for cancellation. Plan reallocation or confirm removal to avoid billing surprises.`,
      affectedCount: pendingCancel.length,
    });
  }

  const wasteTeams = new Map<string, number>();
  for (const s of inactive30) {
    const team = s.assigningTeamSlug ?? '(unassigned)';
    wasteTeams.set(team, (wasteTeams.get(team) ?? 0) + 1);
  }
  const realloc = [...wasteTeams.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])[0];
  if (realloc) {
    const [team, count] = realloc;
    findings.push({
      id: 'reallocation-opportunity',
      severity: 'info',
      category: 'reallocation',
      title: 'Suggested reallocation opportunity',
      message: `Team "${team}" has ${count} inactive seats. Reassign to active engineers or remove to save ~$${(count * seatPrice).toFixed(0)}/month.`,
      estimatedImpactUsd: count * seatPrice,
      affectedCount: count,
    });
  }

  return findings;
}

export interface MemberSpendFindingInput {
  githubLogin: string;
  teamSlug: string;
  teamName: string;
  totalAllocatedCost: number;
  estimatedValueCreated: number;
  roiPercentage: number | null;
  aiCreditsUsed: number;
  utilizationStatus: string;
  seatCost: number;
}

/** Member-level spend attribution findings — advisory, estimated impact only. */
export function generateMemberSpendFindings(args: {
  members: MemberSpendFindingInput[];
  seats: SeatForFindings[];
  memberTeams: { githubLogin: string; teamSlug: string; teamName: string }[];
  assumptions: CopilotRoiAssumptions;
  now?: Date;
}): CopilotFinding[] {
  const findings: CopilotFinding[] = [];
  const seatPrice = args.assumptions.seatPriceUsd ?? DEFAULT_SEAT_PRICE_USD;
  const highRoiThreshold = args.assumptions.highRoiThreshold ?? 100;

  for (const m of args.members.filter((x) => x.utilizationStatus === 'inactive')) {
    findings.push({
      id: `inactive-seat-${m.githubLogin}`,
      severity: 'critical',
      category: 'seat_waste',
      title: `Inactive seat: ${m.githubLogin}`,
      message: `${m.githubLogin} has a paid Copilot seat but has no activity in the last ${args.assumptions.inactiveDaysThreshold ?? 30} days. Estimated wasted spend: $${seatPrice.toFixed(0)}/month.`,
      estimatedImpactUsd: seatPrice,
      affectedCount: 1,
    });
  }

  for (const m of args.members.filter(
    (x) => x.roiPercentage != null && x.roiPercentage < 0 && x.totalAllocatedCost > 0,
  )) {
    findings.push({
      id: `low-roi-${m.githubLogin}`,
      severity: 'warning',
      category: 'roi',
      title: `Low ROI: ${m.githubLogin}`,
      message: `${m.githubLogin} has estimated Copilot cost of $${m.totalAllocatedCost.toFixed(2)} but only $${m.estimatedValueCreated.toFixed(2)} in estimated value. Consider enablement, training, or seat reassignment.`,
    });
  }

  for (const m of args.members.filter(
    (x) => x.roiPercentage != null && x.roiPercentage >= highRoiThreshold,
  ).slice(0, 5)) {
    findings.push({
      id: `high-roi-${m.githubLogin}`,
      severity: 'info',
      category: 'roi',
      title: `High ROI: ${m.githubLogin}`,
      message: `${m.githubLogin} generated an estimated $${m.estimatedValueCreated.toFixed(2)} in value from $${m.totalAllocatedCost.toFixed(2)} in Copilot spend. ROI: ${m.roiPercentage!.toFixed(0)}%.`,
    });
  }

  const creditSorted = [...args.members].sort((a, b) => b.aiCreditsUsed - a.aiCreditsUsed);
  const topCreditCutoff = Math.max(1, Math.ceil(creditSorted.length * 0.2));
  for (const m of creditSorted.slice(0, topCreditCutoff)) {
    if (m.aiCreditsUsed <= 0) continue;
    findings.push({
      id: `high-credit-${m.githubLogin}`,
      severity: 'info',
      category: 'credits',
      title: `High credit usage: ${m.githubLogin}`,
      message: `${m.githubLogin} is one of the top Copilot credit users. Review whether usage is producing accepted code, PR summaries, or other measurable output.`,
    });
  }

  const teamInactive = new Map<string, { count: number; name: string }>();
  for (const m of args.members.filter((x) => x.utilizationStatus === 'inactive')) {
    const team = m.teamSlug || '(unassigned)';
    const name = m.teamName || team;
    const cur = teamInactive.get(team) ?? { count: 0, name };
    cur.count += 1;
    teamInactive.set(team, cur);
  }
  for (const [team, info] of teamInactive) {
    if (info.count < 1) continue;
    findings.push({
      id: `team-waste-${team}`,
      severity: 'warning',
      category: 'seat_waste',
      title: `Team waste: ${info.name}`,
      message: `${info.name} has ${info.count} inactive seat${info.count === 1 ? '' : 's'}. Estimated monthly waste: $${(info.count * seatPrice).toFixed(0)}.`,
      estimatedImpactUsd: info.count * seatPrice,
      affectedCount: info.count,
    });
  }

  const inactiveLogins = new Set(args.members.filter((m) => m.utilizationStatus === 'inactive').map((m) => m.githubLogin));
  if (inactiveLogins.size >= 2) {
    findings.push({
      id: 'reallocation-opportunity',
      severity: 'info',
      category: 'reallocation',
      title: 'Suggested seat reallocation',
      message:
        'Consider reallocating seats from inactive members to users with frequent GitHub activity but no Copilot seat.',
      affectedCount: inactiveLogins.size,
    });
  }

  return findings;
}

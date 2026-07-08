import type { CopilotBillingLineRow } from './github-copilot.types';
import type { MemberDailySpendInput, MemberDailySpendResult } from './github-copilot-member-spend';
import { calculateMemberDailySpend, dailySeatCost } from './github-copilot-member-spend';

/** UTC calendar months touched by a day lookback ending today. */
export function monthsInLookback(days: number, end = new Date()): { year: number; month: number }[] {
  const seen = new Map<string, { year: number; month: number }>();
  for (let d = 0; d < days; d++) {
    const dt = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - d),
    );
    const year = dt.getUTCFullYear();
    const month = dt.getUTCMonth() + 1;
    seen.set(`${year}-${month}`, { year, month });
  }
  return [...seen.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

export function parseUsageDay(isoDay: string): { year: number; month: number; day: number } {
  const [y, m, d] = isoDay.split('-').map(Number);
  return { year: y, month: m, day: d };
}

export type BillingDailyAggregate = {
  githubLogin: string;
  usageDate: string;
  grossQuantity: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
};

/** Roll billing lines up to one row per (user, day). */
export function aggregateBillingByUserDay(lines: CopilotBillingLineRow[]): Map<string, BillingDailyAggregate> {
  const out = new Map<string, BillingDailyAggregate>();
  for (const line of lines) {
    const key = `${line.usageDate}|${line.githubLogin.toLowerCase()}`;
    const cur = out.get(key) ?? {
      githubLogin: line.githubLogin,
      usageDate: line.usageDate,
      grossQuantity: 0,
      grossAmount: 0,
      discountAmount: 0,
      netAmount: 0,
    };
    cur.grossQuantity += line.grossQuantity;
    cur.grossAmount += line.grossAmount;
    cur.discountAmount += line.discountAmount;
    cur.netAmount += line.netAmount;
    out.set(key, cur);
  }
  return out;
}

export function billingLookupKey(usageDate: string, githubLogin: string): string {
  return `${usageDate}|${githubLogin.toLowerCase()}`;
}

/** Month bucket for de-duplicating invoice-grade credit vs daily estimates. */
export function billingMonthKey(usageDate: string, githubLogin: string): string {
  return `${usageDate.slice(0, 7)}|${githubLogin.toLowerCase()}`;
}

/** Users/months with any billing API row — credit overage is counted once on the billing day. */
export function billingMonthsFromUserDay(
  billingByUserDay: Map<string, BillingDailyAggregate>,
): Set<string> {
  const months = new Set<string>();
  for (const agg of billingByUserDay.values()) {
    months.add(billingMonthKey(agg.usageDate, agg.githubLogin));
  }
  return months;
}

/**
 * Member spend when GitHub billing API rows exist: seat proration + billed net
 * credit overage (matches invoice net_amount, not metrics estimates).
 */
export function calculateMemberDailySpendWithBilling(
  input: MemberDailySpendInput,
  billing: BillingDailyAggregate,
): MemberDailySpendResult {
  const estimated = calculateMemberDailySpend(input);
  const seatCost =
    input.seat?.isActive && input.seat.monthlySeatCost
      ? dailySeatCost(input.seat.monthlySeatCost, input.usage.usageDate)
      : 0;
  const billedNet = round2(billing.netAmount);
  const billedGross = round2(billing.grossAmount);
  const totalAllocatedCost = round2(seatCost + billedNet);

  const roiPct =
    estimated.estimatedValueCreated > 0 && totalAllocatedCost > 0
      ? round2(((estimated.estimatedValueCreated - totalAllocatedCost) / totalAllocatedCost) * 100)
      : estimated.roiPercentage;

  return {
    ...estimated,
    seatCost: round2(seatCost),
    estimatedCreditCost: billedGross,
    allocatedOverageCost: billedNet,
    totalAllocatedCost,
    aiCreditsUsed: round2(billing.grossQuantity),
    roiPercentage: roiPct,
    confidenceScore: 0.98,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

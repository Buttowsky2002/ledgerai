import type { UserUtilizationStatus } from './user-value.types';

export const UTILIZATION_CAVEAT =
  'Utilization proxy from metered usage; not a measure of individual output or business value.';

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

export function seatMonthlyCost(
  monthlyPricePerUser: number,
  contractMonthlyCost: number,
  seatsPurchased: number,
): number {
  if (monthlyPricePerUser > 0) return usd(monthlyPricePerUser);
  if (seatsPurchased > 0 && contractMonthlyCost > 0) {
    return usd(contractMonthlyCost / seatsPurchased);
  }
  return 0;
}

/** Utilization proxy in [0,100] from metered activity signals. */
export function computeUtilizationScore(
  activeDays: number,
  calls: number,
  sessions: number,
  periodDays: number,
): number {
  const dayRatio = Math.min(1, activeDays / Math.max(1, periodDays * 0.5));
  const callFactor = Math.min(1, calls / 50);
  const sessionFactor = Math.min(1, sessions / 10);
  return Math.round((dayRatio * 0.4 + callFactor * 0.35 + sessionFactor * 0.25) * 100);
}

export function computeUserStatus(
  calls: number,
  sessions: number,
  utilizationScore: number,
  hasSeat: boolean,
): UserUtilizationStatus {
  if (calls === 0 && sessions === 0) return 'inactive';
  if (hasSeat && utilizationScore < 30) return 'low_use';
  if (utilizationScore < 20) return 'low_use';
  return 'active';
}

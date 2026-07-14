import { prorateMonthlyCost } from '../fixed-costs/fixed-cost-prorate';

export interface CursorFixedCostMonthRow {
  period_month: string;
  cost_usd: number;
  seats: number;
  unit_cost_usd: number;
}

const usd = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Per-seat monthly unit from a fixed-cost row: unit_cost_usd first, else cost/seats. */
export function resolveCursorSeatUnitCost(row: {
  cost_usd: number;
  seats: number;
  unit_cost_usd: number;
}): number {
  const unit = Number(row.unit_cost_usd) || 0;
  if (unit > 0) return unit;
  const seats = Number(row.seats) || 0;
  const cost = Number(row.cost_usd) || 0;
  if (seats > 0 && cost > 0) return cost / seats;
  return 0;
}

/** Billing months (UTC) that overlap [from, to], inclusive. */
export function billingMonthsInRange(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7)) - 1;
  const end = new Date(`${to.slice(0, 10)}T00:00:00.000Z`);
  let cursor = new Date(Date.UTC(year, month, 1));
  while (cursor <= end) {
    months.push(
      `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-01`,
    );
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

/** Seat license = sum of prorated (unit × activeMembers) per fixed-cost month row. */
export function computeCursorSeatLicenseFromFixedCosts(
  rows: CursorFixedCostMonthRow[],
  activeMembers: number,
  from: string,
  to: string,
): { seatLicenseUsd: number; seatCount: number; seatUnitUsdPerMonth: number } {
  if (rows.length === 0) {
    return { seatLicenseUsd: 0, seatCount: activeMembers, seatUnitUsdPerMonth: 0 };
  }

  const sorted = [...rows].sort((a, b) =>
    String(a.period_month).localeCompare(String(b.period_month)),
  );
  const latestUnit = resolveCursorSeatUnitCost(sorted[sorted.length - 1]);

  if (activeMembers <= 0) {
    return {
      seatLicenseUsd: 0,
      seatCount: 0,
      seatUnitUsdPerMonth: usd(latestUnit),
    };
  }

  let total = 0;
  for (const row of sorted) {
    const unit = resolveCursorSeatUnitCost(row);
    if (unit <= 0) continue;
    total += prorateMonthlyCost(unit * activeMembers, String(row.period_month), from, to);
  }

  return {
    seatLicenseUsd: usd(total),
    seatCount: activeMembers,
    seatUnitUsdPerMonth: usd(latestUnit),
  };
}

/** Subscription-plan fallback when no fixed-cost rows match. */
export function computeCursorSeatLicenseFromPlans(
  plans: { seats_purchased: number; monthly_price_per_user: number; contract_monthly_cost: number }[],
  activeMembers: number,
  from: string,
  to: string,
): { seatLicenseUsd: number; seatCount: number; seatUnitUsdPerMonth: number } {
  if (plans.length === 0) {
    return { seatLicenseUsd: 0, seatCount: 0, seatUnitUsdPerMonth: 0 };
  }

  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  const planSeats = plans.reduce((s, p) => s + n(p.seats_purchased), 0);
  const monthlyTotal = plans.reduce((s, p) => {
    const contract = n(p.contract_monthly_cost);
    if (contract > 0) return s + contract;
    return s + n(p.monthly_price_per_user) * n(p.seats_purchased);
  }, 0);
  const unit = planSeats > 0 ? monthlyTotal / planSeats : n(plans[0]?.monthly_price_per_user);
  const billableMembers = activeMembers > 0 ? activeMembers : planSeats;

  if (unit <= 0 || billableMembers <= 0) {
    return { seatLicenseUsd: 0, seatCount: billableMembers, seatUnitUsdPerMonth: usd(unit) };
  }

  const monthlyUsd = unit * billableMembers;
  let total = 0;
  for (const month of billingMonthsInRange(from, to)) {
    total += prorateMonthlyCost(monthlyUsd, month, from, to);
  }

  return {
    seatLicenseUsd: usd(total),
    seatCount: billableMembers,
    seatUnitUsdPerMonth: usd(unit),
  };
}

/**
 * Allocate Fixed Overhead (fixed_costs) seat dollars onto users by platform
 * presence and basic/premium tier. Tagging premium never creates new spend —
 * it only moves a user from the basic pool into the premium pool.
 */

import {
  billingMonthsInRange,
  latestSeatByVendorOnOrBefore,
  type FixedCostSeatRow,
} from '../fixed-costs/fixed-cost-prorate';
import { platformToVendor } from './vendor-spend';

export type SeatClass = 'basic' | 'premium';

export type SeatTierAssignment = {
  user_id: string;
  vendor: string;
  tier: SeatClass;
};

export type UserPlatformPresence = {
  user_id: string;
  /** Vendors the user appears on in the range (usage, membership, or seat). */
  vendors: string[];
  /** Optional activity score for seat-count capping (higher = preferred). */
  activity_score?: number;
};

export type SeatPool = {
  vendor: string;
  tier: SeatClass;
  /** Period seat $ to allocate (already range-scoped). */
  seat_usd: number;
  /** Purchased seat count when known; 0 = uncapped. */
  seats: number;
};

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

function vendorName(v: string): string {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}

function unitUsd(row: FixedCostSeatRow): number {
  const seats = Number(row.seats ?? 0);
  const cost = Number(row.cost_usd ?? 0);
  if (seats > 0 && cost > 0) {
    return cost / seats;
  }
  return 0;
}

/** Keyword class from plan name; null when ambiguous. */
export function keywordSeatClass(
  lineItem?: string | null,
  costType?: string | null,
): SeatClass | null {
  const li = String(lineItem ?? '').toLowerCase();
  const ct = String(costType ?? '').toLowerCase();
  if (ct === 'subscription' || /\b(enterprise|max|premium|ultra)\b/.test(li)) {
    return 'premium';
  }
  if (/\b(team|standard|free|basic|plus)\b/.test(li) || /\bpro\b/.test(li)) {
    return 'basic';
  }
  return null;
}

function assignSeatClass(
  lineItem: string,
  costType: string,
  unit: number,
  vendorUnits: number[],
): SeatClass {
  const distinct = [...new Set(vendorUnits.filter((u) => u > 0))].sort((a, b) => a - b);
  if (distinct.length >= 2) {
    const lo = distinct[0]!;
    const hi = distinct[distinct.length - 1]!;
    const mid = (lo + hi) / 2;
    if (unit > mid) {
      return 'premium';
    }
    if (unit < mid || unit === lo) {
      return 'basic';
    }
  }
  return keywordSeatClass(lineItem, costType) ?? 'basic';
}

type LineSnap = {
  vendor: string;
  month: string;
  line_item: string;
  cost_type: string;
  seat_usd: number;
  seats: number;
  unit_usd: number;
};

function lineItemKey(row: FixedCostSeatRow): string {
  return `${vendorName(String(row.vendor ?? 'other'))}\0${String(row.cost_type ?? '').trim()}\0${String(row.line_item ?? '').trim()}`;
}

function collectLatestLineItems(rows: FixedCostSeatRow[], billingMonth: string): LineSnap[] {
  const limit = billingMonth.slice(0, 7);
  const best = new Map<string, LineSnap>();
  for (const row of rows) {
    const month = String(row.period_month ?? '').slice(0, 7);
    if (!month || month > limit) {
      continue;
    }
    const key = lineItemKey(row);
    const prev = best.get(key);
    if (prev && prev.month > month) {
      continue;
    }
    const snap: LineSnap = {
      vendor: vendorName(String(row.vendor ?? 'other')),
      month,
      line_item: String(row.line_item ?? ''),
      cost_type: String(row.cost_type ?? ''),
      seat_usd: Number(row.cost_usd ?? 0),
      seats: Number(row.seats ?? 0),
      unit_usd: unitUsd(row),
    };
    if (prev && prev.month === month) {
      prev.seat_usd += snap.seat_usd;
      prev.seats += snap.seats;
      continue;
    }
    best.set(key, snap);
  }
  return [...best.values()];
}

/** Build basic/premium pools for one billing month (monthly run-rate). */
export function seatPoolsForMonth(rows: FixedCostSeatRow[], billingMonth: string): SeatPool[] {
  const lines = collectLatestLineItems(rows, billingMonth);
  const byVendorUnits = new Map<string, number[]>();
  for (const line of lines) {
    const list = byVendorUnits.get(line.vendor) ?? [];
    list.push(line.unit_usd);
    byVendorUnits.set(line.vendor, list);
  }

  const byKey = new Map<string, SeatPool>();
  for (const line of lines) {
    if (line.seat_usd <= 0 && line.seats <= 0) {
      continue;
    }
    const tier = assignSeatClass(
      line.line_item,
      line.cost_type,
      line.unit_usd,
      byVendorUnits.get(line.vendor) ?? [],
    );
    const key = `${line.vendor}:${tier}`;
    const cur = byKey.get(key) ?? {
      vendor: line.vendor,
      tier,
      seat_usd: 0,
      seats: 0,
    };
    cur.seat_usd += line.seat_usd;
    cur.seats += line.seats;
    byKey.set(key, cur);
  }
  return [...byKey.values()].map((p) => ({
    ...p,
    seat_usd: usd(p.seat_usd),
  }));
}

/**
 * Period seat pools: one full monthly charge per billing month in range
 * (matches periodSeatTotalForRange), split by vendor + tier.
 */
export function seatPoolsForRange(rows: FixedCostSeatRow[], from: string, to: string): SeatPool[] {
  const months = billingMonthsInRange(from, to);
  if (months.length === 0) {
    return [];
  }
  // Single-month ranges use current (latest) run-rate — same as periodSeatTotalForRange.
  const monthsToUse = months.length === 1 ? [months[0]!] : months;

  const byKey = new Map<string, SeatPool>();
  for (const month of monthsToUse) {
    for (const pool of seatPoolsForMonth(rows, month)) {
      const key = `${pool.vendor}:${pool.tier}`;
      const cur = byKey.get(key) ?? {
        vendor: pool.vendor,
        tier: pool.tier,
        seat_usd: 0,
        seats: 0,
      };
      cur.seat_usd += pool.seat_usd;
      // Seat count: take max across months (capacity), not sum.
      cur.seats = Math.max(cur.seats, pool.seats);
      byKey.set(key, cur);
    }
  }
  return [...byKey.values()].map((p) => ({ ...p, seat_usd: usd(p.seat_usd) }));
}

/** Vendors that have any fixed_costs seat pool in the period. */
export function vendorsWithFixedSeatPools(pools: SeatPool[]): Set<string> {
  return new Set(pools.filter((p) => p.seat_usd > 0).map((p) => p.vendor));
}

function tierLookup(assignments: SeatTierAssignment[]): Map<string, Map<string, SeatClass>> {
  const out = new Map<string, Map<string, SeatClass>>();
  for (const a of assignments) {
    const uid = String(a.user_id);
    const vendor = vendorName(a.vendor);
    if (!uid || !vendor) {
      continue;
    }
    const byVendor = out.get(uid) ?? new Map<string, SeatClass>();
    byVendor.set(vendor, a.tier === 'premium' ? 'premium' : 'basic');
    out.set(uid, byVendor);
  }
  return out;
}

function userTierFor(
  userId: string,
  vendor: string,
  lookup: Map<string, Map<string, SeatClass>>,
  aliases?: Map<string, string>,
): SeatClass {
  const canon = aliases?.get(userId.toLowerCase()) ?? userId;
  const byVendor = lookup.get(canon) ?? lookup.get(userId);
  return byVendor?.get(vendorName(vendor)) ?? 'basic';
}

/**
 * Allocate each (vendor, tier) Fixed Overhead pool onto eligible users with
 * matching platform presence.
 *
 * When purchased seats > 0, each eligible user gets the FO unit price
 * (`seat_usd / seats`) — matching Fixed Overhead catalog pricing. Users are
 * not dropped when headcount exceeds purchased seats (Users may sum above FO).
 * When seats is 0, equal-split the pool across eligible users.
 *
 * Returns Map<userId, Record<vendor, seat_usd>>.
 */
export function allocateSeatPools(input: {
  pools: SeatPool[];
  presence: UserPlatformPresence[];
  tiers?: SeatTierAssignment[];
  /** Optional map of directory user_id → identity user_id for tier lookup. */
  userIdAliases?: Map<string, string>;
}): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const lookup = tierLookup(input.tiers ?? []);
  const aliases = input.userIdAliases;

  const add = (userId: string, vendor: string, amount: number) => {
    if (amount <= 0) {
      return;
    }
    const cur = out.get(userId) ?? {};
    cur[vendor] = usd((cur[vendor] ?? 0) + amount);
    out.set(userId, cur);
  };

  for (const pool of input.pools) {
    if (pool.seat_usd <= 0) {
      continue;
    }
    const vendor = vendorName(pool.vendor);
    const eligible = input.presence
      .filter((p) => p.vendors.some((v) => vendorName(v) === vendor))
      .filter((p) => userTierFor(p.user_id, vendor, lookup, aliases) === pool.tier)
      .sort((a, b) => (b.activity_score ?? 0) - (a.activity_score ?? 0));

    if (eligible.length === 0) {
      continue;
    }

    if (pool.seats > 0) {
      const unit = usd(pool.seat_usd / pool.seats);
      for (const user of eligible) {
        add(user.user_id, vendor, unit);
      }
      continue;
    }

    // Uncapped pool: equal-split so sum matches pool.seat_usd.
    const share = usd(pool.seat_usd / eligible.length);
    let allocated = 0;
    for (let i = 0; i < eligible.length; i++) {
      const user = eligible[i]!;
      const amount = i === eligible.length - 1 ? usd(pool.seat_usd - allocated) : share;
      allocated = usd(allocated + amount);
      add(user.user_id, vendor, amount);
    }
  }

  return out;
}

/** Derive presence vendors from model breakdown + explicit memberships. */
export function presenceVendorsFromBreakdown(
  modelBreakdown: { platform: string; spend_usd?: number; calls?: number }[],
  extraVendors: string[] = [],
): string[] {
  const set = new Set<string>();
  for (const row of modelBreakdown) {
    set.add(platformToVendor(row.platform));
  }
  for (const v of extraVendors) {
    const n = vendorName(v);
    if (n) {
      set.add(n);
    }
  }
  return [...set];
}

/**
 * Connector-only fallback seats (Cursor/Copilot) when fixed_costs has no pool
 * for that vendor — preserves pre-allocator behavior.
 */
export function mergeAllocatedWithConnectorFallback(
  allocated: Map<string, Record<string, number>>,
  connectorSeats: Map<string, Record<string, number>>,
  fixedVendors: Set<string>,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const userIds = new Set([...allocated.keys(), ...connectorSeats.keys()]);
  for (const userId of userIds) {
    const base = { ...(allocated.get(userId) ?? {}) };
    const fallback = connectorSeats.get(userId) ?? {};
    for (const [vendor, seatUsd] of Object.entries(fallback)) {
      const v = vendorName(vendor);
      if (fixedVendors.has(v)) {
        continue;
      }
      if ((base[v] ?? 0) <= 0 && seatUsd > 0) {
        base[v] = usd(seatUsd);
      }
    }
    if (Object.keys(base).length > 0) {
      out.set(userId, base);
    }
  }
  return out;
}

/** Sum of allocated seat $ across all users (for residual vs org checks). */
export function sumAllocatedSeats(allocated: Map<string, Record<string, number>>): number {
  let total = 0;
  for (const byVendor of allocated.values()) {
    for (const v of Object.values(byVendor)) {
      total += v;
    }
  }
  return usd(total);
}

/** Re-export for callers that need latest vendor snap without tier split. */
export { latestSeatByVendorOnOrBefore };

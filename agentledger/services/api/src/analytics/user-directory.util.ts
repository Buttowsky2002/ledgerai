import { isEmailLike } from '../reports/identity-resolver';
import type { UserDirectoryIdentity } from '../reports/identity-resolver';
import { modelFamilyLabel } from './model-family';
import {
  buildUserVendorSpend,
  buildUserVendorUsage,
  sumUserVendorSpend,
  type VendorSpendSlice,
  type VendorUsageSlice,
} from './vendor-spend';
import type { UserDirectoryRow, UserModelBreakdownRow } from './analytics.service';

// Pure user-directory assembly helpers extracted verbatim from AnalyticsService
// so the service file stays under the god-file threshold. These functions do no
// I/O — they only transform data the service has already fetched — so they carry
// no `this` dependency and are unit-testable in isolation.

/** Coerce a ClickHouse scalar (numbers may arrive as strings) to a number. */
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Attach Cursor included/on-demand fields and surface included-only members.
 * Included usage value never increases total_spend_usd (metered/invoice totals).
 */
export function mergeCursorActivityIntoUserSpend(
  totals: {
    user_id: string;
    total_spend_usd: unknown;
    calls: unknown;
    tokens?: unknown;
    portal_import_usd?: unknown;
    connector_usd?: unknown;
    cursor_on_demand_usd?: unknown;
    cursor_included_usd?: unknown;
  }[],
  breakdown: {
    user_id: string;
    platform: string;
    model: string;
    spend_usd: unknown;
    calls: unknown;
    portal_import_usd?: unknown;
    connector_usd?: unknown;
    usage_value_usd?: unknown;
  }[],
  cursorPack: {
    totals: {
      user_id: string;
      on_demand_usd: number;
      usage_value_usd: number;
      calls: number;
      included_calls?: number;
      tokens?: number;
    }[];
    breakdown: {
      user_id: string;
      model: string;
      on_demand_usd: number;
      usage_value_usd: number;
      calls: number;
    }[];
  },
) {
  const totalsByUser = new Map(
    totals.map((row) => [
      String(row.user_id),
      {
        user_id: String(row.user_id),
        total_spend_usd: row.total_spend_usd,
        calls: row.calls,
        tokens: n(row.tokens),
        portal_import_usd: row.portal_import_usd,
        connector_usd: row.connector_usd,
        cursor_on_demand_usd: n(row.cursor_on_demand_usd),
        cursor_included_usd: n(row.cursor_included_usd),
      },
    ]),
  );

  for (const row of cursorPack.totals) {
    const existing = totalsByUser.get(row.user_id);
    const includedCalls = Number(row.included_calls ?? 0);
    if (existing) {
      existing.cursor_on_demand_usd = row.on_demand_usd;
      existing.cursor_included_usd = row.usage_value_usd;
      if (n(existing.calls) <= 0 && row.calls > 0) {
        existing.calls = row.calls;
      } else if (includedCalls > 0) {
        existing.calls = n(existing.calls) + includedCalls;
      }
      if (n(existing.tokens) <= 0 && (row.tokens ?? 0) > 0) {
        existing.tokens = row.tokens ?? 0;
      }
    } else {
      totalsByUser.set(row.user_id, {
        user_id: row.user_id,
        total_spend_usd: row.on_demand_usd,
        calls: row.calls,
        tokens: row.tokens ?? 0,
        portal_import_usd: 0,
        connector_usd: row.on_demand_usd,
        cursor_on_demand_usd: row.on_demand_usd,
        cursor_included_usd: row.usage_value_usd,
      });
    }
  }

  const breakdownOut = [...breakdown];
  const seenCursorModels = new Set(
    breakdown
      .filter((row) => String(row.platform).toLowerCase() === 'cursor')
      .map((row) => `${row.user_id}::${row.model}`),
  );
  for (const row of cursorPack.breakdown) {
    const key = `${row.user_id}::${row.model}`;
    if (seenCursorModels.has(key)) {
      const idx = breakdownOut.findIndex(
        (b) =>
          String(b.user_id) === row.user_id &&
          String(b.platform).toLowerCase() === 'cursor' &&
          String(b.model) === row.model,
      );
      if (idx >= 0) {
        breakdownOut[idx] = {
          ...breakdownOut[idx],
          spend_usd: Math.max(n(breakdownOut[idx].spend_usd), row.on_demand_usd),
          usage_value_usd: row.usage_value_usd,
          // Prefer activity call count so included-only models still show volume.
          calls: Math.max(n(breakdownOut[idx].calls), row.calls),
        };
      }
      continue;
    }
    seenCursorModels.add(key);
    breakdownOut.push({
      user_id: row.user_id,
      platform: 'cursor',
      model: row.model,
      spend_usd: row.on_demand_usd,
      calls: row.calls,
      usage_value_usd: row.usage_value_usd,
    });
  }

  return { totals: [...totalsByUser.values()], breakdown: breakdownOut };
}

export function enrichUsersWithVendorData(
  users: UserDirectoryRow[],
  copilotByUser: Map<string, { seat_usd: number; overage_usd: number; calls: number }>,
  cursorSeatByUser: Map<string, number>,
  tokensByUserVendor: Map<string, Record<string, number>>,
  cursorTotals: { user_id: string; calls: number; tokens?: number }[],
): UserDirectoryRow[] {
  const cursorByUser = new Map(
    cursorTotals.map((row) => [
      String(row.user_id),
      { calls: n(row.calls), tokens: n((row as { tokens?: unknown }).tokens) },
    ]),
  );

  return users.map((user) => {
    const copilot = copilotByUser.get(user.user_id);
    const cursorSeat = cursorSeatByUser.get(user.user_id) ?? 0;
    const cursorActivity = cursorByUser.get(user.user_id);
    const vendor_spend = buildUserVendorSpend({
      model_breakdown: user.model_breakdown,
      cursor_on_demand_usd: user.cursor_on_demand_usd ?? 0,
      cursor_seat_usd: cursorSeat,
      copilot: copilot
        ? { seat_usd: copilot.seat_usd, overage_usd: copilot.overage_usd }
        : undefined,
    });
    const vendor_usage = buildUserVendorUsage({
      model_breakdown: user.model_breakdown,
      tokens_by_vendor: tokensByUserVendor.get(user.user_id) ?? {},
      cursor_calls: cursorActivity?.calls ?? 0,
      cursor_tokens: cursorActivity?.tokens ?? 0,
      copilot_calls: copilot?.calls ?? 0,
      modelFamilyLabel,
    });
    return {
      ...user,
      vendor_spend,
      vendor_usage,
      total_spend_usd: sumUserVendorSpend(vendor_spend),
    };
  });
}

export function canonicalUserKey(user_id: string, identity: UserDirectoryIdentity): string {
  if (identity.email) {
    return `email:${identity.email.toLowerCase()}`;
  }
  if (isEmailLike(user_id)) {
    return `email:${user_id.trim().toLowerCase()}`;
  }
  return `raw:${user_id.toLowerCase()}`;
}

export function mergeUserDirectoryRows(a: UserDirectoryRow, b: UserDirectoryRow): UserDirectoryRow {
  const primary = a.total_spend_usd >= b.total_spend_usd ? a : b;
  const secondary = primary === a ? b : a;
  const resolved = a.resolved ? a : b.resolved ? b : primary;

  const breakdownMap = new Map<string, UserModelBreakdownRow>();
  for (const row of [...a.model_breakdown, ...b.model_breakdown]) {
    const key = `${row.platform}::${row.model}`;
    const existing = breakdownMap.get(key);
    if (existing) {
      existing.spend_usd = usd(existing.spend_usd + row.spend_usd);
      existing.calls += row.calls;
      const usage = (existing.usage_value_usd ?? 0) + (row.usage_value_usd ?? 0);
      if (usage > 0) {
        existing.usage_value_usd = usd(usage);
      }
    } else {
      breakdownMap.set(key, { ...row });
    }
  }
  const model_breakdown = [...breakdownMap.values()].sort((x, y) => y.spend_usd - x.spend_usd);
  const models = model_breakdown.map((m) => m.model).filter((m, i, arr) => arr.indexOf(m) === i);

  return {
    user_id: primary.user_id,
    display_name: resolved.display_name,
    email: resolved.email ?? primary.email ?? secondary.email,
    team: resolved.team || primary.team || secondary.team,
    resolved: a.resolved || b.resolved,
    total_spend_usd: usd(a.total_spend_usd + b.total_spend_usd),
    calls: a.calls + b.calls,
    tokens: (a.tokens ?? 0) + (b.tokens ?? 0),
    portal_import_usd: usd((a.portal_import_usd ?? 0) + (b.portal_import_usd ?? 0)),
    connector_usd: usd((a.connector_usd ?? 0) + (b.connector_usd ?? 0)),
    cursor_on_demand_usd: usd((a.cursor_on_demand_usd ?? 0) + (b.cursor_on_demand_usd ?? 0)),
    cursor_included_usd: usd((a.cursor_included_usd ?? 0) + (b.cursor_included_usd ?? 0)),
    models,
    model_breakdown,
    vendor_spend: mergeVendorSpendRecords(a.vendor_spend, b.vendor_spend),
    vendor_usage: mergeVendorUsageRecords(a.vendor_usage, b.vendor_usage),
  };
}

export function mergeVendorSpendRecords(
  a?: Record<string, VendorSpendSlice>,
  b?: Record<string, VendorSpendSlice>,
): Record<string, VendorSpendSlice> | undefined {
  if (!a && !b) {
    return undefined;
  }
  const out: Record<string, VendorSpendSlice> = { ...(a ?? {}) };
  for (const [vendor, slice] of Object.entries(b ?? {})) {
    const cur = out[vendor] ?? { seat_usd: 0, overage_usd: 0, total_usd: 0 };
    out[vendor] = {
      seat_usd: usd(cur.seat_usd + slice.seat_usd),
      overage_usd: usd(cur.overage_usd + slice.overage_usd),
      total_usd: usd(cur.total_usd + slice.total_usd),
    };
  }
  return out;
}

export function mergeVendorUsageRecords(
  a?: Record<string, VendorUsageSlice>,
  b?: Record<string, VendorUsageSlice>,
): Record<string, VendorUsageSlice> | undefined {
  if (!a && !b) {
    return undefined;
  }
  const out: Record<string, VendorUsageSlice> = {};
  for (const src of [a, b]) {
    if (!src) {
      continue;
    }
    for (const [vendor, slice] of Object.entries(src)) {
      const cur = out[vendor] ?? { calls: 0, tokens: 0, models: [], model_breakdown: [] };
      cur.calls += slice.calls;
      cur.tokens += slice.tokens;
      cur.model_breakdown = [...cur.model_breakdown, ...slice.model_breakdown];
      const families = new Set([...cur.models, ...slice.models]);
      cur.models = [...families];
      out[vendor] = cur;
    }
  }
  return out;
}

export function userMatchesQuery(user: UserDirectoryRow, needle: string): boolean {
  const fields = [user.display_name, user.email, user.team, user.user_id];
  return fields.some((f) => f && f.toLowerCase().includes(needle));
}

/** Minimal model row for vendor aggregation (mirrors UserModelBreakdownRow). */
export type VendorModelBreakdownRow = {
  model: string;
  platform: string;
  spend_usd: number;
  calls: number;
  usage_value_usd?: number;
};

/** Per-vendor billable slice — seat + budget overage (metered beyond pool). */
export interface VendorSpendSlice {
  seat_usd: number;
  overage_usd: number;
  total_usd: number;
}

/** Usage metrics for a vendor tab on the user detail page. */
export interface VendorUsageSlice {
  calls: number;
  tokens: number;
  /** Condensed model family labels (Claude, Cursor, …). */
  models: string[];
  model_breakdown: VendorModelBreakdownRow[];
}

export interface OrgVendorBillingRow {
  vendor: string;
  seat_usd: number;
  budget_overage_usd: number;
  total_usd: number;
  /** Latest-month seat count from fixed_costs (monthly, not prorated). */
  seats?: number;
  prior_seats?: number | null;
  /** Monthly run-rate $ from seat-count change vs previous billing month. */
  usd_from_seats?: number;
  usd_from_rate?: number;
  prior_period_month?: string | null;
}

const SEAT_ALLOCATED_PLATFORMS = ['github_copilot', 'github_copilot_business'] as const;

const VENDOR_OVERRIDES: Record<string, string> = {
  github_copilot: 'github',
  github_copilot_business: 'github',
  azure_openai: 'azure',
  vertex: 'google',
  bedrock: 'aws',
};

function normalizePlatform(platform: string): string {
  return platform.trim().toLowerCase().replace(/\s+/g, '_');
}

export function platformToVendor(platform: string): string {
  const p = normalizePlatform(platform);
  if (p.includes('copilot')) {
    return 'github';
  }
  return VENDOR_OVERRIDES[p] ?? p;
}

export function isSeatAllocatedPlatform(platform: string): boolean {
  const p = normalizePlatform(platform);
  return (SEAT_ALLOCATED_PLATFORMS as readonly string[]).includes(p) || p.includes('copilot');
}

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

function ensureSlice(out: Record<string, VendorSpendSlice>, vendor: string): VendorSpendSlice {
  const key = vendor.trim().toLowerCase() || 'other';
  if (!out[key]) {
    out[key] = { seat_usd: 0, overage_usd: 0, total_usd: 0 };
  }
  return out[key];
}

function finalizeSlice(slice: VendorSpendSlice): void {
  slice.seat_usd = usd(slice.seat_usd);
  slice.overage_usd = usd(slice.overage_usd);
  slice.total_usd = usd(slice.seat_usd + slice.overage_usd);
}

/** Build per-user vendor spend from metered breakdown + Cursor/Copilot splits. */
export function buildUserVendorSpend(input: {
  model_breakdown: VendorModelBreakdownRow[];
  cursor_on_demand_usd: number;
  cursor_seat_usd: number;
  copilot?: { seat_usd: number; overage_usd: number };
}): Record<string, VendorSpendSlice> {
  const out: Record<string, VendorSpendSlice> = {};

  if (input.copilot && (input.copilot.seat_usd > 0 || input.copilot.overage_usd > 0)) {
    const gh = ensureSlice(out, 'github');
    gh.seat_usd = input.copilot.seat_usd;
    gh.overage_usd = input.copilot.overage_usd;
    finalizeSlice(gh);
  }

  if (input.cursor_on_demand_usd > 0 || input.cursor_seat_usd > 0) {
    const cur = ensureSlice(out, 'cursor');
    cur.seat_usd = input.cursor_seat_usd;
    cur.overage_usd = input.cursor_on_demand_usd;
    finalizeSlice(cur);
  }

  // Cursor metered rows when on-demand analytics field is unset (legacy CH path).
  if ((out.cursor?.overage_usd ?? 0) <= 0) {
    for (const row of input.model_breakdown) {
      if (normalizePlatform(row.platform) !== 'cursor') {
        continue;
      }
      const cur = ensureSlice(out, 'cursor');
      cur.overage_usd += row.spend_usd;
      finalizeSlice(cur);
    }
  }

  for (const row of input.model_breakdown) {
    const platform = row.platform;
    if (isSeatAllocatedPlatform(platform) || normalizePlatform(platform) === 'cursor') {
      continue;
    }
    const slice = ensureSlice(out, platformToVendor(platform));
    slice.overage_usd += row.spend_usd;
    finalizeSlice(slice);
  }

  return out;
}

/** Sum vendor column totals for a user row. */
export function sumUserVendorSpend(vendorSpend: Record<string, VendorSpendSlice>): number {
  return usd(Object.values(vendorSpend).reduce((s, v) => s + v.total_usd, 0));
}

/** Dynamic vendor column order — highest org/user total first. */
export function orderedVendorIds(
  vendorSpendMaps: Record<string, VendorSpendSlice>[],
  orgBilling?: OrgVendorBillingRow[],
): string[] {
  const totals = new Map<string, number>();
  for (const map of vendorSpendMaps) {
    for (const [vendor, slice] of Object.entries(map)) {
      totals.set(vendor, (totals.get(vendor) ?? 0) + slice.total_usd);
    }
  }
  for (const row of orgBilling ?? []) {
    totals.set(row.vendor, (totals.get(row.vendor) ?? 0) + row.total_usd);
  }
  return [...totals.entries()]
    .filter(([, t]) => t > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => v);
}

/** Group model breakdown + token map into per-vendor usage for detail tabs. */
export function buildUserVendorUsage(input: {
  model_breakdown: VendorModelBreakdownRow[];
  tokens_by_vendor: Record<string, number>;
  cursor_calls: number;
  cursor_tokens: number;
  copilot_calls: number;
  modelFamilyLabel: (platform: string, model: string) => string;
}): Record<string, VendorUsageSlice> {
  const out: Record<string, VendorUsageSlice> = {};

  const ensure = (vendor: string): VendorUsageSlice => {
    const key = vendor.trim().toLowerCase() || 'other';
    if (!out[key]) {
      out[key] = { calls: 0, tokens: 0, models: [], model_breakdown: [] };
    }
    return out[key];
  };

  for (const row of input.model_breakdown) {
    const vendor = platformToVendor(row.platform);
    const slice = ensure(vendor);
    slice.model_breakdown.push(row);
    slice.calls += row.calls;
  }

  if (input.cursor_calls > 0 || input.cursor_tokens > 0) {
    const cur = ensure('cursor');
    cur.calls += input.cursor_calls;
    cur.tokens += input.cursor_tokens;
  }

  if (input.copilot_calls > 0) {
    const gh = ensure('github');
    gh.calls += input.copilot_calls;
  }

  for (const [vendor, tokens] of Object.entries(input.tokens_by_vendor)) {
    if (tokens <= 0) {
      continue;
    }
    ensure(vendor).tokens += tokens;
  }

  for (const slice of Object.values(out)) {
    slice.model_breakdown.sort((a, b) => b.spend_usd - a.spend_usd);
    const families = new Map<string, number>();
    for (const row of slice.model_breakdown) {
      const label = input.modelFamilyLabel(row.platform, row.model);
      families.set(label, (families.get(label) ?? 0) + row.spend_usd);
    }
    slice.models = [...families.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  }

  return out;
}

/** Org-level vendor billing: fixed seats + metered budget overage. */
export function buildOrgVendorBilling(
  seatUsdByVendor: Record<string, number>,
  overageUsdByVendor: Record<string, number>,
): OrgVendorBillingRow[] {
  const vendors = new Set([...Object.keys(seatUsdByVendor), ...Object.keys(overageUsdByVendor)]);
  const rows: OrgVendorBillingRow[] = [];
  for (const vendor of vendors) {
    const seat_usd = usd(seatUsdByVendor[vendor] ?? 0);
    const budget_overage_usd = usd(overageUsdByVendor[vendor] ?? 0);
    const total_usd = usd(seat_usd + budget_overage_usd);
    if (total_usd <= 0) {
      continue;
    }
    rows.push({ vendor, seat_usd, budget_overage_usd, total_usd });
  }
  return rows.sort((a, b) => b.total_usd - a.total_usd);
}

export function mergeVendorSpendMaps(
  a: Record<string, VendorSpendSlice>,
  b: Record<string, VendorSpendSlice>,
): Record<string, VendorSpendSlice> {
  const out: Record<string, VendorSpendSlice> = { ...a };
  for (const [vendor, slice] of Object.entries(b)) {
    const cur = ensureSlice(out, vendor);
    cur.seat_usd += slice.seat_usd;
    cur.overage_usd += slice.overage_usd;
    finalizeSlice(cur);
  }
  return out;
}

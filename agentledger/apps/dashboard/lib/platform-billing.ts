/**
 * How a platform's spend splits between usage metering and seat licensing.
 *
 * The platform list is built from `llm_calls.provider`, which carries no
 * billing metadata, so the split is derived from two real sources: the
 * platform's metered spend and the tenant's `fixed_costs` rows for the
 * matching vendor. Only the *shape* of a vendor's billing (Copilot bills per
 * seat, so its platform row is an allocation rather than metered usage) is
 * encoded here; the amounts always come from data.
 */

/**
 * Platform slugs (`llm_calls.provider`) whose spend is a seat allocation, not
 * metered usage. Copilot spend is derived from per-seat billing lines in
 * Postgres, so counting it as metered would misreport how the vendor charges.
 */
const SEAT_ALLOCATED_PLATFORMS = ['github_copilot', 'github_copilot_business'] as const;

/** Platform slug → `fixed_costs.vendor` id, where the two vocabularies differ. */
const VENDOR_OVERRIDES: Record<string, string> = {
  github_copilot: 'github',
  github_copilot_business: 'github',
  azure_openai: 'azure',
  vertex: 'google',
  bedrock: 'aws',
  lovable: 'lovable',
};

function normalize(platform: string): string {
  return platform.trim().toLowerCase().replace(/\s+/g, '_');
}

/** True when the platform's own spend represents seat licences, not usage. */
export function isSeatAllocatedPlatform(platform: string): boolean {
  const p = normalize(platform);
  return (SEAT_ALLOCATED_PLATFORMS as readonly string[]).includes(p) || p.includes('copilot');
}

/** Resolve the `fixed_costs.vendor` id that corresponds to a platform slug. */
export function fixedCostVendorForPlatform(platform: string): string {
  const p = normalize(platform);
  if (p.includes('copilot')) {
    return 'github';
  }
  return VENDOR_OVERRIDES[p] ?? p;
}

/** Sum fixed-cost rows into a `vendor → USD` map for the selected period. */
export function seatUsdByVendor(
  rows: Array<{ vendor?: string | null; cost_usd?: number | string | null }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const vendor =
      String(row.vendor ?? '')
        .trim()
        .toLowerCase() || 'other';
    const usd = Number(row.cost_usd ?? 0);
    if (!Number.isFinite(usd) || usd === 0) {
      continue;
    }
    out[vendor] = (out[vendor] ?? 0) + usd;
  }
  return out;
}

export type PlatformBillingSplit = {
  meteredUsd: number;
  seatUsd: number;
  cursorIncludedUsd: number;
};

/**
 * Split one platform row into metered vs seat spend.
 *
 * `platformCostUsd` is the metered total from the analytics store;
 * `vendorSeatUsd` is that vendor's `fixed_costs` total for the same period;
 * `cursorIncludedUsd` is subscription-included usage value, which is neither
 * (it never appears on an invoice).
 */
export function platformBillingSplit(
  platform: string,
  platformCostUsd: number,
  vendorSeatUsd: Record<string, number> = {},
  cursorIncludedUsd = 0,
): PlatformBillingSplit {
  const cost = Number.isFinite(platformCostUsd) ? platformCostUsd : 0;
  const seatFromFixedCosts = vendorSeatUsd[fixedCostVendorForPlatform(platform)] ?? 0;

  if (isSeatAllocatedPlatform(platform)) {
    return { meteredUsd: 0, seatUsd: cost + seatFromFixedCosts, cursorIncludedUsd: 0 };
  }
  return {
    meteredUsd: cost,
    seatUsd: seatFromFixedCosts,
    cursorIncludedUsd: Math.max(0, cursorIncludedUsd),
  };
}

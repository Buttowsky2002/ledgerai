export type VendorSpendSlice = {
  seat_usd: number;
  overage_usd: number;
  total_usd: number;
};

export type VendorUsageSlice = {
  calls: number;
  tokens: number;
  models: string[];
  model_breakdown: {
    model: string;
    platform: string;
    spend_usd: number;
    calls: number;
    usage_value_usd?: number;
  }[];
};

export type OrgVendorBillingRow = {
  vendor: string;
  seat_usd: number;
  budget_overage_usd: number;
  total_usd: number;
};

export function vendorShortLabel(vendor: string): string {
  const map: Record<string, string> = {
    anthropic: 'Ant',
    openai: 'OpenAI',
    cursor: 'Cursor',
    github: 'GH',
    google: 'Google',
    lovable: 'Lovable',
    azure: 'Azure',
    aws: 'AWS',
  };
  return map[vendor.toLowerCase()] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

export function sumVendorColumns(
  users: { vendor_spend?: Record<string, VendorSpendSlice> }[],
  vendors: string[],
): Record<string, VendorSpendSlice> {
  const out: Record<string, VendorSpendSlice> = {};
  for (const vendor of vendors) {
    out[vendor] = { seat_usd: 0, overage_usd: 0, total_usd: 0 };
  }
  for (const user of users) {
    for (const vendor of vendors) {
      const slice = user.vendor_spend?.[vendor];
      if (!slice) continue;
      out[vendor].seat_usd += slice.seat_usd;
      out[vendor].overage_usd += slice.overage_usd;
      out[vendor].total_usd += slice.total_usd;
    }
  }
  return out;
}

export function userVendorTotal(user: { vendor_spend?: Record<string, VendorSpendSlice> }): number {
  if (!user.vendor_spend) return 0;
  return Object.values(user.vendor_spend).reduce((s, v) => s + v.total_usd, 0);
}

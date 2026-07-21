import type { FixedCostType, FixedCostVendor } from '@/types/fixed-costs';

/** AI vendors commonly tracked for seat / subscription overhead. */
export const AI_VENDORS: { id: FixedCostVendor; label: string; product: string }[] = [
  { id: 'openai', label: 'OpenAI', product: 'ChatGPT' },
  { id: 'anthropic', label: 'Anthropic', product: 'Claude' },
  { id: 'cursor', label: 'Cursor', product: 'Cursor' },
  { id: 'google', label: 'Google', product: 'Gemini' },
  { id: 'azure', label: 'Azure OpenAI', product: 'Azure OpenAI' },
  { id: 'github', label: 'GitHub', product: 'Copilot' },
  { id: 'aws', label: 'AWS', product: 'Bedrock' },
  { id: 'cohere', label: 'Cohere', product: 'Cohere' },
  { id: 'mistral', label: 'Mistral', product: 'Mistral' },
  { id: 'perplexity', label: 'Perplexity', product: 'Perplexity' },
  { id: 'other', label: 'Other', product: 'Custom' },
];

export const PLAN_TIERS = ['free', 'team', 'enterprise'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const PLAN_TIER_LABELS: Record<PlanTier, string> = {
  free: 'Free',
  team: 'Team',
  enterprise: 'Enterprise',
};

/** Default USD per seat/month when known — undefined means enter manually. */
const DEFAULT_UNIT_USD: Partial<Record<FixedCostVendor, Partial<Record<PlanTier, number | undefined>>>> = {
  openai: { free: 0, team: 30 },
  anthropic: { free: 0, team: 30 },
  cursor: { free: 0, team: 40 },
  google: { free: 0, team: 20 },
  github: { free: 0, team: 19 },
  perplexity: { free: 0, team: 20 },
  other: { free: 0 },
};

export function vendorLabel(vendor: string): string {
  return AI_VENDORS.find((v) => v.id === vendor)?.label ?? vendor;
}

export function costTypeForTier(tier: PlanTier): FixedCostType {
  if (tier === 'enterprise') return 'subscription';
  if (tier === 'free') return 'seat_license';
  return 'seat_license';
}

export function lineItemFor(vendor: FixedCostVendor, tier: PlanTier, customName?: string): string {
  if (vendor === 'other' && customName?.trim()) return customName.trim();
  const product = AI_VENDORS.find((v) => v.id === vendor)?.product ?? vendor;
  return `${product} ${PLAN_TIER_LABELS[tier]}`;
}

export function defaultUnitUsd(vendor: FixedCostVendor, tier: PlanTier): number | null {
  if (tier === 'free') return 0;
  const row = DEFAULT_UNIT_USD[vendor];
  const v = row?.[tier];
  return v === undefined ? null : v;
}

/** Infer vendor + tier from a stored row (for edit form). */
export function parseStoredPlan(
  vendor: string,
  lineItem: string,
  costType: string,
): { vendor: FixedCostVendor; tier: PlanTier } {
  const v = (AI_VENDORS.some((x) => x.id === vendor) ? vendor : 'other') as FixedCostVendor;
  const li = lineItem.toLowerCase();
  if (li.includes('enterprise') || costType === 'subscription') {
    return { vendor: v, tier: 'enterprise' };
  }
  if (li.includes('free')) return { vendor: v, tier: 'free' };
  if (li.includes('team')) return { vendor: v, tier: 'team' };
  return { vendor: v, tier: costType === 'subscription' ? 'enterprise' : 'team' };
}

export function aggregateByVendor(
  rows: { vendor: string; cost_usd: number | string }[],
): { vendor: string; label: string; total: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    const key = r.vendor || 'other';
    map.set(key, (map.get(key) ?? 0) + Number(r.cost_usd ?? 0));
  }
  return [...map.entries()]
    .map(([vendor, total]) => ({ vendor, label: vendorLabel(vendor), total }))
    .sort((a, b) => b.total - a.total);
}

/** AI vendors for fixed overhead — keep in sync with apps/dashboard/lib/fixed-cost-catalog.ts */
export const FIXED_COST_VENDORS = [
  'openai',
  'anthropic',
  'cursor',
  'google',
  'azure',
  'github',
  'aws',
  'cohere',
  'mistral',
  'perplexity',
  'other',
] as const;

export type FixedCostVendorId = (typeof FIXED_COST_VENDORS)[number];

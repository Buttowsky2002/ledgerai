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
export type FixedCostVendor = (typeof FIXED_COST_VENDORS)[number];

export const FIXED_COST_TYPES = [
  'seat_license',
  'subscription',
  'platform_fee',
  'committed_use',
] as const;
export type FixedCostType = (typeof FIXED_COST_TYPES)[number];

export type FixedCostRow = {
  tenant_id: string;
  period_month: string;
  vendor: FixedCostVendor;
  cost_type: FixedCostType;
  line_item: string;
  seats: number;
  unit_cost_usd: number;
  cost_usd: number;
  currency: string;
  attributable: number;
  source: string;
  note: string;
  imported_at: string;
};

export type MonthlyFixedRow = {
  period_month: string;
  vendor: string;
  cost_type: string;
  cost_usd: number | string;
  seats?: number | string;
  last_imported_at?: string;
};

export type TotalCostOfAiRow = {
  month: string;
  attributable_cost_usd: number | string;
  fixed_cost_usd: number | string;
  total_cost_of_ai_usd: number | string;
  fixed_cost_pct: number | string;
};

export type CreateFixedCostInput = {
  periodMonth: string;
  vendor: FixedCostVendor;
  costType: FixedCostType;
  costUsd: number;
  lineItem?: string;
  seats?: number;
  unitCostUsd?: number;
  note?: string;
};

export type UpdateFixedCostInput = CreateFixedCostInput & {
  costUsd?: number;
};

export type DeleteFixedCostInput = {
  periodMonth: string;
  vendor: FixedCostVendor;
  costType: FixedCostType;
  lineItem?: string;
};

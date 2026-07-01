/**
 * Shared normalized usage event shape — the contract between connector sync and
 * the analytics import pipeline. Stored in NormalizedRecord.metrics and mapped
 * to ClickHouse llm_calls via toImportRow().
 */
export interface NormalizedUsageEvent {
  provider: string;
  platformDisplayName?: string;
  timestamp: string;
  model?: string;
  requestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costSource?: string;
  status?: string;

  // Attribution dimensions (populated when provider exposes them)
  providerUserId?: string;
  userEmail?: string;
  userName?: string;
  apiKeyId?: string;
  apiKeyName?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  organizationId?: string;
  organizationName?: string;
  serviceAccountId?: string;
  serviceAccountName?: string;
  teamId?: string;
  teamName?: string;

  // Billing metadata
  providerReportedCost?: number;
  currency?: string;
  billingPeriod?: string;
  usageDate?: string;
  modelPricingRef?: string;
}

/** Snake_case keys used inside NormalizedRecord.metrics after field mapping. */
export type NormalizedUsageMetrics = {
  provider?: string;
  platform_display_name?: string;
  ts?: string;
  timestamp?: string;
  model?: string;
  request_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  cost_source?: string;
  status?: string;
  user_id?: string;
  user_email?: string;
  user_name?: string;
  api_key_id?: string;
  api_key_name?: string;
  project_id?: string;
  project_name?: string;
  workspace_id?: string;
  workspace_name?: string;
  organization_id?: string;
  organization_name?: string;
  service_account_id?: string;
  service_account_name?: string;
  team_id?: string;
  team_name?: string;
  provider_reported_cost?: number;
  currency?: string;
  billing_period?: string;
  usage_date?: string;
  model_pricing_ref?: string;
  attribution_method?: string;
  [key: string]: unknown;
};

export const UNASSIGNED_USER = 'Unassigned';

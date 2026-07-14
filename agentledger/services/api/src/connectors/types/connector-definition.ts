import type { ConnectorCapabilities } from './connector-capabilities';

/** BadgerIQ connector definition schema — config-driven API connector framework. */

export type ConnectorCategory =
  | 'provider_spend'
  | 'ai_usage'
  | 'coding_tool'
  | 'gateway_logs'
  | 'observability'
  | 'cloud_cost'
  | 'outcome_system'
  | 'risk_security'
  | 'custom';

export type ConnectorAuthType =
  | 'api_key_header'
  | 'bearer_token'
  | 'basic_auth'
  | 'oauth2_client_credentials'
  | 'oauth2_authorization_code'
  | 'custom_header'
  | 'none';

export type PaginationType =
  | 'cursor'
  | 'offset'
  | 'page'
  | 'next_url'
  | 'response_token'
  | 'none';

export type DestinationRecordType =
  | 'spend_usage_record'
  | 'llm_call_record'
  | 'coding_activity_record'
  | 'outcome_record'
  | 'risk_event_record'
  | 'tool_usage_record'
  | 'identity_record'
  | 'custom_metric_record';

export type DedupeStrategy =
  | 'provider_record_id'
  | 'period_model_user_product_cost'
  | 'period_project_api_key_line_item'
  | 'custom';

export interface ConnectorEndpoint {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  /** Repeated query keys (e.g. group_by[]=workspace_id&group_by[]=model). */
  queryParamArrays?: Record<string, string[]>;
  bodyTemplate?: string;
}

export interface PaginationConfig {
  type: PaginationType;
  cursorPath?: string;
  nextUrlPath?: string;
  itemsPath?: string;
  /** Flatten nested arrays on each item (e.g. Anthropic usage buckets → results rows). */
  flattenPath?: string;
  pageParam?: string;
  offsetParam?: string;
  limitParam?: string;
  pageSize?: number;
  cursorParam?: string;
  tokenPath?: string;
  tokenParam?: string;
  maxPages?: number;
  /** Dot-path to boolean has-next flag (e.g. pagination.hasNextPage). Overrides item-count heuristic. */
  hasMorePath?: string;
  /** Where page/cursor params are sent when not using bodyTemplate placeholders. Default: query. */
  location?: 'query' | 'body';
}

export interface RateLimitConfig {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  retryAfterHeader?: string;
}

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: number[];
}

export type FieldMappingRule =
  | { type: 'direct'; source: string; target: string }
  | { type: 'constant'; target: string; value: unknown }
  | { type: 'fallback'; target: string; sources: string[] }
  | { type: 'derived'; target: string; expression: string }
  | { type: 'nested'; source: string; target: string; preserveInMetadata?: boolean };

export interface ValidationRule {
  field: string;
  required?: boolean;
  type?: 'string' | 'number' | 'date' | 'currency';
  min?: number;
  max?: number;
}

export interface DedupeConfig {
  strategy: DedupeStrategy;
  customExpression?: string;
  fields?: string[];
}

export interface ScheduleConfig {
  cron?: string;
  intervalMinutes?: number;
  enabled?: boolean;
}

/** Optional second API fetch merged into primary records (e.g. Anthropic cost + usage). */
export interface SupplementalFetchConfig {
  endpoint: ConnectorEndpoint;
  pagination?: PaginationConfig;
  fieldMappings: FieldMappingRule[];
  validationRules?: ValidationRule[];
  mergeOn: string[];
}

/** Optional parallel API fetch producing separate normalized records (e.g. Cursor daily activity). */
export interface CompanionFetchConfig {
  /** Step id for stepsCompleted, e.g. 'codingActivity'. */
  id?: string;
  destinationRecordType: DestinationRecordType;
  endpoint: ConnectorEndpoint;
  pagination?: PaginationConfig;
  fieldMappings: FieldMappingRule[];
  validationRules?: ValidationRule[];
  dedupe?: DedupeConfig;
  /** If true, skip when primary fetch returned zero rows (default false). */
  skipWhenPrimaryEmpty?: boolean;
}

export interface ConnectorDefinition {
  id?: string;
  name: string;
  provider: string;
  category: ConnectorCategory;
  authType: ConnectorAuthType;
  authHeaderName?: string;
  baseUrl: string;
  endpoints: ConnectorEndpoint[];
  requestMethod?: 'GET' | 'POST';
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  queryParamArrays?: Record<string, string[]>;
  bodyTemplate?: string;
  pagination?: PaginationConfig;
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  responseDataPath?: string;
  fieldMappings: FieldMappingRule[];
  validationRules?: ValidationRule[];
  dedupe?: DedupeConfig;
  schedule?: ScheduleConfig;
  destinationRecordType: DestinationRecordType;
  supplementalFetch?: SupplementalFetchConfig;
  companionFetches?: CompanionFetchConfig[];
  /** When the primary endpoint is unavailable (e.g. Enterprise-only), retry with this config. */
  fallbackDefinition?: Pick<
    ConnectorDefinition,
    'endpoints' | 'pagination' | 'fieldMappings' | 'validationRules' | 'responseDataPath'
  >;
  dateRangeParams?: {
    startParam?: string;
    endParam?: string;
    format?: 'iso' | 'unix' | 'unix_ms' | 'date';
  };
  /** Per-request sync window limits (defaults to global 31-day chunks when omitted). */
  syncRange?: {
    maxDaysPerRequest?: number;
    defaultBackfillDays?: number;
  };
  /** Declares what this connector can pull — drives sync steps and UI warnings. */
  capabilities?: ConnectorCapabilities;
}

export interface TemplateContext {
  tenant_id: string;
  connector_id: string;
  sync_start: string;
  sync_end: string;
  /** UTC midnight ISO for provider APIs that bucket by calendar day. */
  sync_start_day?: string;
  sync_end_day?: string;
  sync_start_unix?: string;
  sync_end_unix?: string;
  /** Epoch milliseconds (inclusive range bounds for APIs like Cursor Admin). */
  sync_start_unix_ms?: string;
  sync_end_unix_ms?: string;
  cursor?: string;
  page?: number;
  page_size?: number;
  now: string;
  last_success_at?: string;
}

export interface ConnectorError {
  code: string;
  message: string;
  statusCode?: number;
  retryable?: boolean;
}

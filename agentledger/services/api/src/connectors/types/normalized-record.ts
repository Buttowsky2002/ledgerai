import { DestinationRecordType } from './connector-definition';

/** Normalized record emitted by the connector engine before import mapping. */
export interface NormalizedRecord {
  tenant_id: string;
  source: 'api';
  source_type: string;
  connector_id: string;
  connector_sync_run_id: string;
  provider: string;
  record_type: DestinationRecordType;
  period_start?: string;
  period_end?: string;
  ts: string;
  lineage: {
    external_record_id?: string;
    dedupe_hash: string;
    connector_definition_id?: string;
    raw_metadata?: Record<string, unknown>;
  };
  metrics: Record<string, unknown>;
}

/** Flat import row shape consumed by import.mapper.mapRow. */
export interface ImportFlatRow {
  idempotency_key: string;
  timestamp?: string;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  tool_name?: string;
  outcome_type?: string;
  outcome_value_usd?: number;
  risk_severity?: string;
  attribution_confidence?: number;
  source?: string;
  user_email?: string;
  project_id?: string;
  product?: string;
}

const RECORD_TYPE_TARGETS: Record<DestinationRecordType, string[]> = {
  spend_usage_record: ['cost_usd', 'provider', 'model', 'input_tokens', 'output_tokens', 'user_id', 'user_email'],
  llm_call_record: ['cost_usd', 'provider', 'model', 'input_tokens', 'output_tokens', 'user_id', 'agent_id'],
  coding_activity_record: ['tool_name', 'user_id', 'agent_id', 'cost_usd'],
  outcome_record: ['outcome_type', 'outcome_value_usd', 'attribution_confidence'],
  risk_event_record: ['risk_severity', 'agent_id'],
  tool_usage_record: ['tool_name', 'agent_id', 'run_id'],
  identity_record: ['user_email', 'user_id'],
  custom_metric_record: ['cost_usd', 'provider'],
};

/** Suggest target field mappings from a sample API record. */
export function suggestMappings(
  sample: Record<string, unknown>,
  recordType: DestinationRecordType,
): { source: string; target: string; confidence: number }[] {
  const flat = flattenKeys(sample);
  const targets = RECORD_TYPE_TARGETS[recordType] ?? [];
  const suggestions: { source: string; target: string; confidence: number }[] = [];

  for (const target of targets) {
    let best: { source: string; confidence: number } | null = null;
    for (const [source, value] of Object.entries(flat)) {
      const conf = scoreMapping(source, target, value);
      if (conf > 0 && (!best || conf > best.confidence)) {
        best = { source, confidence: conf };
      }
    }
    if (best && best.confidence >= 0.5) {
      suggestions.push({ source: best.source, target, confidence: best.confidence });
    }
  }
  return suggestions;
}

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenKeys(v as Record<string, unknown>, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function scoreMapping(source: string, target: string, value: unknown): number {
  const s = source.toLowerCase();
  const t = target.toLowerCase();
  if (s.endsWith(t) || s === t) return 0.95;
  if (s.includes(t.replace(/_/g, '')) || s.includes(t)) return 0.8;
  const aliases: Record<string, string[]> = {
    cost_usd: ['cost', 'spend', 'amount', 'price', 'total_cost'],
    input_tokens: ['prompt_tokens', 'input', 'tokens_in'],
    output_tokens: ['completion_tokens', 'output', 'tokens_out'],
    model: ['model_name', 'request_model', 'response_model'],
    user_email: ['email', 'user.email', 'actor.email'],
    user_id: ['user', 'userId', 'actor.user_id', 'account_id'],
    outcome_type: ['type', 'event_type'],
  };
  const list = aliases[target] ?? [];
  if (list.some((a) => s.includes(a))) return 0.75;
  if (target.includes('token') && typeof value === 'number') return 0.4;
  if (target.includes('cost') && typeof value === 'number') return 0.4;
  return 0;
}

/** Convert a normalized record to a flat import row for the analytics pipeline. */
export function toImportRow(record: NormalizedRecord): ImportFlatRow {
  const m = record.metrics;
  const row: ImportFlatRow = {
    idempotency_key: `conn_${record.connector_id}_${record.lineage.dedupe_hash}`,
    timestamp: record.ts,
    source: 'api',
  };

  const assign = (target: keyof ImportFlatRow, ...keys: string[]) => {
    for (const k of keys) {
      if (m[k] !== undefined && m[k] !== null && m[k] !== '') {
        (row as unknown as Record<string, unknown>)[target] = m[k];
        return;
      }
    }
  };

  assign('provider', 'provider');
  assign('model', 'model', 'request_model', 'response_model');
  assign('input_tokens', 'input_tokens', 'prompt_tokens');
  assign('output_tokens', 'output_tokens', 'completion_tokens');
  assign('cost_usd', 'cost_usd', 'cost', 'spend', 'amount');
  assign('team_id', 'team_id');
  assign('user_id', 'user_id');
  assign('agent_id', 'agent_id');
  assign('run_id', 'run_id');
  assign('tool_name', 'tool_name', 'tool');
  assign('outcome_type', 'outcome_type', 'type');
  assign('outcome_value_usd', 'outcome_value_usd', 'value_usd', 'business_value_usd');
  assign('risk_severity', 'risk_severity', 'severity');
  assign('attribution_confidence', 'attribution_confidence');
  assign('user_email', 'user_email', 'email');
  assign('project_id', 'project_id');
  assign('product', 'product', 'cost_type', 'line_item');

  if (!row.provider && record.provider) row.provider = record.provider;

  return row;
}

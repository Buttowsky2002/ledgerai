import { randomUUID } from 'node:crypto';
import { computeMeteredCostUsd } from '../connectors/metered-cost';

/**
 * Maps a raw import row (the supported flat fields) to one or more canonical
 * ClickHouse rows. A row may carry usage, an outcome, a tool call, and/or a risk
 * signal; each present signal becomes its own event. Validation throws
 * ImportRowError with a human-readable message (the service attaches the line #).
 *
 * tenant_id is NOT set here — the service stamps it from the request principal.
 */
export class ImportRowError extends Error {}

export interface MappedEvent {
  table: 'llm_calls' | 'agent_tool_calls' | 'outcomes' | 'risk_events' | 'coding_agent_daily';
  row: Record<string, unknown>;
}
export interface MappedRow {
  idempotencyKey?: string;
  events: MappedEvent[];
}

const RISK_SEVERITIES = ['low', 'medium', 'high', 'critical'];

function str(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  throw new ImportRowError(`field "${field}" must be a string`);
}

function num(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ImportRowError(`field "${field}" must be a number`);
  if (n < 0) throw new ImportRowError(`field "${field}" must be >= 0`);
  return n;
}

/** An attribution confidence in [0,1]; defaults to 1 when absent. */
function confidence(v: unknown): number {
  const c = num(v, 'attribution_confidence');
  if (c === undefined) return 1;
  if (c > 1) throw new ImportRowError(`field "attribution_confidence" must be between 0 and 1`);
  return c;
}

function isoTs(v: unknown): string {
  if (v === undefined || v === null || v === '') return new Date().toISOString();
  const d = new Date(typeof v === 'number' ? v : String(v));
  if (Number.isNaN(d.getTime())) throw new ImportRowError(`field "timestamp" is not a valid date/time`);
  return d.toISOString();
}

function id(prefix: string, key: string | undefined, suffix = ''): string {
  return key ? `imp_${key}${suffix}` : `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

const CODING_AGENT_ALIASES: Record<string, string> = {
  cursor: 'cursor',
  'claude-code': 'claude-code',
  'claude code': 'claude-code',
  copilot: 'github-copilot',
  'github-copilot': 'github-copilot',
  'github copilot': 'github-copilot',
};

function codingAgentProvider(provider: string | undefined, toolName: string): string | undefined {
  const probe = `${provider ?? ''} ${toolName}`.toLowerCase();
  for (const [alias, canonical] of Object.entries(CODING_AGENT_ALIASES)) {
    if (probe.includes(alias)) return canonical;
  }
  return undefined;
}

export function mapRow(data: unknown): MappedRow {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ImportRowError('row is not a JSON object');
  }
  const r = data as Record<string, unknown>;

  const ts = isoTs(r.timestamp);
  const idempotencyKey = str(r.idempotency_key ?? r.idem_key, 'idempotency_key');
  const teamId = str(r.team_id, 'team_id') ?? '';
  const userId =
    str(r.user_id, 'user_id') ??
    str(r.user_email, 'user_email') ??
    str(r.user_name, 'user_name') ??
    '';
  const agentId = str(r.agent_id, 'agent_id') ?? '';
  const runId = str(r.run_id, 'run_id') ?? '';

  const provider = str(r.provider, 'provider');
  const platformDisplayName = str(r.platform_display_name, 'platform_display_name');
  const model = str(r.model, 'model');
  const inputTokens = num(r.input_tokens, 'input_tokens');
  const outputTokens = num(r.output_tokens, 'output_tokens');
  const costUsd = num(r.cost_usd, 'cost_usd');
  const usageValueUsd = num(r.usage_value_usd, 'usage_value_usd');
  const costSource = str(r.cost_source, 'cost_source') ?? '';
  const meteredCostUsdRaw = num(r.metered_cost_usd, 'metered_cost_usd');
  const operationName = str(r.operation_name, 'operation_name');
  const callStatus = str(r.status, 'status') ?? 'ok';
  const toolName = str(r.tool_name, 'tool_name');
  const outcomeType = str(r.outcome_type, 'outcome_type');
  const outcomeValueUsd = num(r.outcome_value_usd, 'outcome_value_usd');

  const riskSeverity = str(r.risk_severity, 'risk_severity');
  if (riskSeverity !== undefined && !RISK_SEVERITIES.includes(riskSeverity)) {
    throw new ImportRowError(`field "risk_severity" must be one of ${RISK_SEVERITIES.join('|')}`);
  }

  const hasUsage =
    provider ||
    model ||
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    costUsd !== undefined ||
    usageValueUsd !== undefined;
  if (!hasUsage && !outcomeType && !toolName && riskSeverity === undefined) {
    throw new ImportRowError('row has no importable fields (need usage, tool_name, outcome_type, or risk_severity)');
  }

  const events: MappedEvent[] = [];

  if (hasUsage) {
    events.push({
      table: 'llm_calls',
      row: {
        call_id: id('call', idempotencyKey),
        ts,
        team_id: teamId,
        user_id: userId,
        agent_id: agentId,
        run_id: runId,
        provider: provider ?? '',
        request_model: model ?? '',
        response_model: model ?? '',
        operation_name: operationName ?? 'chat',
        input_tokens: Math.round(inputTokens ?? 0),
        output_tokens: Math.round(outputTokens ?? 0),
        cost_usd: costUsd ?? 0,
        usage_value_usd: usageValueUsd ?? costUsd ?? 0,
        metered_cost_usd:
          meteredCostUsdRaw ??
          computeMeteredCostUsd({
            provider: provider ?? '',
            cost_usd: costUsd ?? 0,
            cost_source: costSource,
            operation_name: operationName ?? '',
            usage_value_usd: usageValueUsd,
            product: str(r.product, 'product') ?? '',
          }),
        cost_source: costSource,
        status: callStatus,
        app_id: platformDisplayName ?? provider ?? '',
        // A risk severity on a usage row marks the call as risk-flagged so it
        // rolls into risk_daily (which counts rows where dlp_action != 'allow').
        dlp_action: riskSeverity ? 'warn' : 'allow',
        risk_severity: riskSeverity ?? '',
        source: str(r.source, 'source') ?? 'sdk',
        import_run_id: str(r.import_run_id, 'import_run_id') ?? '',
      },
    });
  }

  if (outcomeType) {
    events.push({
      table: 'outcomes',
      row: {
        outcome_id: id('out', idempotencyKey, '_out'),
        ts,
        source_system: str(r.source, 'source') === 'api' ? 'api' : 'import',
        outcome_type: outcomeType,
        team_id: teamId,
        user_id: userId,
        run_id: runId,
        business_value_usd: outcomeValueUsd ?? 0,
        quality_score: 0,
        // Imported outcomes are asserted by the operator → full attribution.
        // Confidence is a probability feeding finance-grade ROI (headline cutoff
        // 0.5, used as a value multiplier), so it is bounded to [0,1] — `num`
        // already rejects < 0; reject > 1 here rather than silently inflate ROI.
        attribution_confidence: confidence(r.attribution_confidence),
        completion_status: 'completed',
      },
    });
  }

  if (toolName) {
    events.push({
      table: 'agent_tool_calls',
      row: {
        agent_id: agentId,
        run_id: runId,
        tool_call_id: id('tool', idempotencyKey, '_tool'),
        tool_name: toolName,
        mcp_server: '',
        ts,
      },
    });
    const codingProvider = codingAgentProvider(provider, toolName);
    if (codingProvider) {
      const linesAccepted = num(r.lines_accepted, 'lines_accepted');
      const linesAdded = num(r.lines_added, 'lines_added');
      const linesDeleted = num(r.lines_deleted, 'lines_deleted');
      const linesCommitted = num(r.lines_committed, 'lines_committed');
      const tabsAccepted = num(r.tabs_accepted, 'tabs_accepted');
      const composerRequests = num(r.composer_requests, 'composer_requests');
      const chatRequests = num(r.chat_requests, 'chat_requests');
      events.push({
        table: 'coding_agent_daily',
        row: {
          day: ts.slice(0, 10),
          provider: codingProvider,
          user_id: userId,
          team_id: teamId,
          agent_id: agentId,
          cost_usd: costUsd ?? 0,
          sessions: 1,
          requests: Math.max(1, Math.round(composerRequests ?? 0) + Math.round(chatRequests ?? 0)),
          lines_accepted: Math.round(linesAccepted ?? 0),
          lines_added: Math.round(linesAdded ?? 0),
          lines_deleted: Math.round(linesDeleted ?? 0),
          lines_committed: Math.round(linesCommitted ?? linesAdded ?? 0),
          tabs_accepted: Math.round(tabsAccepted ?? 0),
          composer_requests: Math.round(composerRequests ?? 0),
          chat_requests: Math.round(chatRequests ?? 0),
        },
      });
    }
  }

  // A standalone risk signal (no usage row to ride on) becomes a risk_event.
  if (riskSeverity !== undefined && !hasUsage) {
    events.push({
      table: 'risk_events',
      row: {
        event_id: id('risk', idempotencyKey, '_risk'),
        agent_id: agentId,
        run_id: runId,
        category: 'imported',
        // risk_events severity vocabulary is low|medium|high.
        severity: riskSeverity === 'critical' ? 'high' : riskSeverity,
        detail: 'imported risk signal',
        occurrences: 1,
        first_seen: ts,
        detected_at: ts,
      },
    });
  }

  return { idempotencyKey, events };
}

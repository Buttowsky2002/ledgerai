import { normalizeHeader } from './csv-parse';
import { detectPortalCsvFormat, type PortalCsvFormat } from './csv-format';

/** Logical field roles for portal billing CSV columns. */
export type PortalColumnRole =
  | 'date'
  | 'cost'
  | 'model'
  | 'user'
  | 'user_name'
  | 'user_id'
  | 'account_uuid'
  | 'input_tokens'
  | 'output_tokens'
  | 'product'
  | 'skip';

export type CostUnit = 'usd' | 'cents';

/** User-selected mapping by original CSV header label. */
export interface ColumnMappingByName {
  date?: string;
  cost: string;
  costUnit?: CostUnit;
  model?: string;
  user?: string;
  user_name?: string;
  user_id?: string;
  account_uuid?: string;
  product?: string;
  input_tokens?: string;
  output_tokens?: string;
  /** When CSV has no date column (Anthropic spend report), stamp rows with this day. */
  reportThroughDay?: string;
}

export interface ResolvedColumnMapping {
  date: number;
  cost: number;
  costUnit: CostUnit;
  model: number;
  user: number;
  user_name: number;
  user_id: number;
  account_uuid: number;
  product: number;
  input_tokens: number;
  output_tokens: number;
  reportThroughDay: string | null;
}

export interface MappingSuggestion {
  byHeader: Record<string, PortalColumnRole | undefined>;
  mapping: Partial<ColumnMappingByName>;
  missingRequired: ('date' | 'cost')[];
  inferredCostUnit: CostUnit;
}

type RoleKey = Exclude<PortalColumnRole, 'skip'>;

const ROLE_PATTERNS: Record<RoleKey, string[]> = {
  date: ['date', 'usage_date', 'day', 'billing_date', 'period', 'starting_at', 'timestamp', 'usage_day'],
  cost: [
    'total_net_spend_usd',
    'total_gross_spend_usd',
    'cost_usd',
    'cost',
    'amount',
    'total_cost',
    'spend',
    'usage_cost',
    'billed_amount',
    'estimated_cost',
    'amount_usd',
  ],
  model: ['model', 'model_name', 'description', 'sku', 'project'],
  product: ['product', 'project', 'service'],
  user: ['user_email', 'email', 'member_email', 'actor_email', 'email_address', 'user', 'member'],
  user_name: ['user_name', 'name', 'member_name', 'display_name', 'actor_name'],
  user_id: ['user_id', 'provider_user_id'],
  account_uuid: ['account_uuid', 'uuid', 'account_id'],
  input_tokens: ['total_prompt_tokens', 'input_tokens', 'prompt_tokens', 'tokens_in'],
  output_tokens: ['total_completion_tokens', 'output_tokens', 'completion_tokens', 'tokens_out'],
};

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const norm = headers.map((h) => ({ raw: h, n: normalizeHeader(h) }));
  for (const c of candidates) {
    const hit = norm.find((h) => h.n === c);
    if (hit) return hit.raw;
  }
  for (const c of candidates) {
    const hit = norm.find((h) => h.n.includes(c) || c.includes(h.n));
    if (hit) return hit.raw;
  }
  return undefined;
}

function inferCostUnit(_headers: string[], costHeader: string | undefined): CostUnit {
  if (!costHeader) return 'usd';
  const n = normalizeHeader(costHeader);
  if (n.includes('cent')) return 'cents';
  return 'usd';
}

function applyRoles(headers: string[], roles: Partial<Record<string, PortalColumnRole>>): MappingSuggestion {
  const byHeader: Record<string, PortalColumnRole | undefined> = {};
  for (const h of headers) byHeader[h] = roles[h] ?? 'skip';

  const pick = (role: PortalColumnRole) => headers.find((x) => byHeader[x] === role);

  const date = pick('date');
  const cost = pick('cost');
  const missingRequired: ('date' | 'cost')[] = [];
  if (!cost) missingRequired.push('cost');

  const mapping: Partial<ColumnMappingByName> = {
    ...(date ? { date } : {}),
    ...(cost ? { cost, costUnit: inferCostUnit(headers, cost) } : {}),
    ...(pick('model') ? { model: pick('model') } : {}),
    ...(pick('product') ? { product: pick('product') } : {}),
    ...(pick('user') ? { user: pick('user') } : {}),
    ...(pick('user_name') ? { user_name: pick('user_name') } : {}),
    ...(pick('user_id') ? { user_id: pick('user_id') } : {}),
    ...(pick('account_uuid') ? { account_uuid: pick('account_uuid') } : {}),
    ...(pick('input_tokens') ? { input_tokens: pick('input_tokens') } : {}),
    ...(pick('output_tokens') ? { output_tokens: pick('output_tokens') } : {}),
  };

  return {
    byHeader,
    mapping,
    missingRequired,
    inferredCostUnit: inferCostUnit(headers, cost),
  };
}

/** Format-specific column mapping (overrides generic heuristics). */
export function suggestColumnMapping(
  headers: string[],
  opts?: { format?: PortalCsvFormat; fileName?: string; reportThroughDay?: string | null },
): MappingSuggestion {
  const detected = detectPortalCsvFormat(headers, opts?.fileName);
  const format = opts?.format ?? detected.format;
  const reportThrough = opts?.reportThroughDay ?? detected.reportTo;

  if (format === 'anthropic_spend_report') {
    const roles: Partial<Record<string, PortalColumnRole>> = {};
    const set = (role: PortalColumnRole, header?: string) => {
      if (header) roles[header] = role;
    };
    set('cost', findHeader(headers, ['total_net_spend_usd', 'total_gross_spend_usd']));
    set('user', findHeader(headers, ['user_email', 'email']));
    set('user_id', findHeader(headers, ['user_id']));
    set('account_uuid', findHeader(headers, ['account_uuid']));
    set('model', findHeader(headers, ['model']));
    set('product', findHeader(headers, ['product']));
    set('input_tokens', findHeader(headers, ['total_prompt_tokens', 'input_tokens']));
    set('output_tokens', findHeader(headers, ['total_completion_tokens', 'output_tokens']));

    const suggestion = applyRoles(headers, roles);
    if (reportThrough) {
      suggestion.mapping.reportThroughDay = reportThrough;
      suggestion.missingRequired = suggestion.mapping.cost ? [] : ['cost'];
    }
    return suggestion;
  }

  if (format === 'anthropic_console' || format === 'unknown') {
    const roles: Partial<Record<string, PortalColumnRole>> = {};
    const set = (role: PortalColumnRole, candidates: string[]) => {
      const h = findHeader(headers, candidates);
      if (h) roles[h] = role;
    };
    set('date', ROLE_PATTERNS.date);
    set('cost', ROLE_PATTERNS.cost);
    set('model', ROLE_PATTERNS.model);
    set('user', ROLE_PATTERNS.user);
    set('user_name', ROLE_PATTERNS.user_name);
    set('input_tokens', ROLE_PATTERNS.input_tokens);
    set('output_tokens', ROLE_PATTERNS.output_tokens);

    const suggestion = applyRoles(headers, roles);
    if (!suggestion.mapping.date) suggestion.missingRequired.push('date');
    return suggestion;
  }

  const byHeader: Record<string, PortalColumnRole | undefined> = {};
  for (const h of headers) byHeader[h] = 'skip';
  return { byHeader, mapping: {}, missingRequired: ['date', 'cost'], inferredCostUnit: 'usd' };
}

export function resolveColumnMapping(
  headers: string[],
  mapping: ColumnMappingByName,
): { resolved: ResolvedColumnMapping | null; error?: string } {
  const idx = (name: string | undefined): number => {
    if (!name) return -1;
    return headers.indexOf(name);
  };

  const cost = idx(mapping.cost);
  if (cost < 0) return { resolved: null, error: `cost column "${mapping.cost}" not found in CSV headers` };

  const date = mapping.date ? idx(mapping.date) : -1;
  const reportThroughDay = mapping.reportThroughDay?.slice(0, 10) ?? null;
  if (date < 0 && !reportThroughDay) {
    return { resolved: null, error: 'date column or reportThroughDay is required' };
  }

  return {
    resolved: {
      date,
      cost,
      costUnit: mapping.costUnit ?? inferCostUnit(headers, mapping.cost),
      model: idx(mapping.model),
      product: idx(mapping.product),
      user: idx(mapping.user),
      user_name: idx(mapping.user_name),
      user_id: idx(mapping.user_id),
      account_uuid: idx(mapping.account_uuid),
      input_tokens: idx(mapping.input_tokens),
      output_tokens: idx(mapping.output_tokens),
      reportThroughDay,
    },
  };
}

export function findHeaderRowIndex(grid: string[][]): number {
  if (grid.length === 0) return 0;
  let bestIdx = 0;
  let bestScore = 0;
  const scan = Math.min(grid.length, 8);
  for (let i = 0; i < scan; i++) {
    const headers = grid[i];
    if (headers.length < 2) continue;
    const format = detectPortalCsvFormat(headers).format;
    let score = 0;
    if (format === 'anthropic_spend_report') score = 100;
    else if (format === 'anthropic_console') score = 90;
    else if (format === 'cursor_analytics' || format === 'claude_code_lines') score = 10;
    else {
      const suggestion = suggestColumnMapping(headers);
      score =
        (suggestion.mapping.date || suggestion.mapping.reportThroughDay ? 50 : 0) +
        (suggestion.mapping.cost ? 50 : 0);
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

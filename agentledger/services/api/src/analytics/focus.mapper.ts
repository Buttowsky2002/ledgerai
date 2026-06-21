// FOCUS 1.2 export mapping (P6-E1, ADR-035). Maps a spend_daily row to a FOCUS
// 1.2 charge record plus AgentLedger x_ai_* extensions, and serializes records to
// CSV. The column order here is the canonical order in schemas/focus/
// focus-1.2.columns.json — keep the two in lockstep.

/** A spend_daily row as returned by the FOCUS export query. */
export interface SpendDailyRow {
  day: string;
  team_id: string;
  app_id: string;
  provider: string;
  model: string;
  input_tokens: number | string;
  output_tokens: number | string;
  cached_tokens: number | string;
  cost_usd: number | string;
  calls: number | string;
}

/** Canonical FOCUS 1.2 + x_ai_* column order (matches the schema file). */
export const FOCUS_COLUMNS = [
  'BillingAccountId',
  'BillingCurrency',
  'BillingPeriodStart',
  'BillingPeriodEnd',
  'ChargePeriodStart',
  'ChargePeriodEnd',
  'ChargeCategory',
  'ChargeDescription',
  'BilledCost',
  'EffectiveCost',
  'ListCost',
  'ProviderName',
  'PublisherName',
  'ServiceName',
  'ServiceCategory',
  'ResourceId',
  'ResourceType',
  'x_ai_provider',
  'x_ai_model',
  'x_ai_team_id',
  'x_ai_app_id',
  'x_ai_input_tokens',
  'x_ai_output_tokens',
  'x_ai_cached_tokens',
  'x_ai_calls',
] as const;

export type FocusRow = Record<(typeof FOCUS_COLUMNS)[number], string | number>;

const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v) || 0);

/** Add `days` days to a 'YYYY-MM-DD' date, returning the same format (UTC). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Map one spend_daily row + the export window into a FOCUS 1.2 record. */
export function toFocusRow(
  row: SpendDailyRow,
  ctx: { tenantId: string; from: string; to: string },
): FocusRow {
  const cost = num(row.cost_usd);
  return {
    BillingAccountId: ctx.tenantId,
    BillingCurrency: 'USD',
    BillingPeriodStart: ctx.from,
    BillingPeriodEnd: ctx.to,
    ChargePeriodStart: row.day,
    ChargePeriodEnd: addDays(row.day, 1),
    ChargeCategory: 'Usage',
    ChargeDescription: `${row.provider} ${row.model} usage`,
    BilledCost: cost,
    EffectiveCost: cost,
    ListCost: cost,
    ProviderName: row.provider,
    PublisherName: row.provider,
    ServiceName: row.model,
    ServiceCategory: 'AI and Machine Learning',
    ResourceId: row.app_id,
    ResourceType: 'AI Application',
    x_ai_provider: row.provider,
    x_ai_model: row.model,
    x_ai_team_id: row.team_id,
    x_ai_app_id: row.app_id,
    x_ai_input_tokens: num(row.input_tokens),
    x_ai_output_tokens: num(row.output_tokens),
    x_ai_cached_tokens: num(row.cached_tokens),
    x_ai_calls: num(row.calls),
  };
}

/** RFC 4180 field escaping: quote when the value holds a comma, quote, or newline. */
function csvField(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize FOCUS records to a CSV string with the canonical header + order. */
export function toCsv(rows: FocusRow[]): string {
  const header = FOCUS_COLUMNS.join(',');
  const lines = rows.map((r) => FOCUS_COLUMNS.map((c) => csvField(r[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

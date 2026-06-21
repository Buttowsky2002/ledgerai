import { FOCUS_COLUMNS, SpendDailyRow, toCsv, toFocusRow } from './focus.mapper';

const row: SpendDailyRow = {
  day: '2026-06-20',
  team_id: 'eng',
  app_id: 'support-copilot',
  provider: 'openai',
  model: 'gpt-4o',
  input_tokens: '1000',
  output_tokens: 500,
  cached_tokens: 200,
  cost_usd: '0.00725',
  calls: 3,
};
const ctx = { tenantId: 't1', from: '2026-06-01', to: '2026-06-30' };

describe('toFocusRow', () => {
  it('maps spend_daily into FOCUS columns + x_ai_* extensions', () => {
    const f = toFocusRow(row, ctx);
    expect(f.BillingAccountId).toBe('t1');
    expect(f.BillingCurrency).toBe('USD');
    expect(f.ChargePeriodStart).toBe('2026-06-20');
    expect(f.ChargePeriodEnd).toBe('2026-06-21'); // day + 1
    expect(f.ChargeDescription).toBe('openai gpt-4o usage');
    expect(f.ServiceName).toBe('gpt-4o');
    expect(f.ProviderName).toBe('openai');
    expect(f.ResourceId).toBe('support-copilot');
    // cost lands in all three FOCUS cost columns, coerced from string
    expect(f.BilledCost).toBe(0.00725);
    expect(f.EffectiveCost).toBe(0.00725);
    expect(f.ListCost).toBe(0.00725);
    // x_ai_* numeric coercion
    expect(f.x_ai_input_tokens).toBe(1000);
    expect(f.x_ai_output_tokens).toBe(500);
    expect(f.x_ai_cached_tokens).toBe(200);
    expect(f.x_ai_calls).toBe(3);
    expect(f.x_ai_team_id).toBe('eng');
  });
});

describe('toCsv', () => {
  it('emits the canonical header order and one line per row', () => {
    const csv = toCsv([toFocusRow(row, ctx)]);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(FOCUS_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('openai gpt-4o usage');
  });

  it('escapes fields containing commas/quotes (RFC 4180)', () => {
    const f = toFocusRow({ ...row, model: 'gpt-4o,"turbo"' }, ctx);
    const csv = toCsv([f]);
    // the model appears inside ChargeDescription + ServiceName, quoted + doubled
    expect(csv).toContain('"openai gpt-4o,""turbo"" usage"');
    expect(csv).toContain('"gpt-4o,""turbo"""');
  });

  it('produces only the header for an empty result', () => {
    expect(toCsv([])).toBe(FOCUS_COLUMNS.join(',') + '\n');
  });
});

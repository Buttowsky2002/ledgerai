import {
  parseAnthropicPortalCsv,
  portalRowIdempotencyKey,
  suggestedApiSyncBaseline,
} from './anthropic-portal.parser';

describe('parseAnthropicPortalCsv', () => {
  it('parses a typical Anthropic portal export', () => {
    const csv = [
      'Usage Date,Model,Member Email,Cost (USD),Input Tokens,Output Tokens',
      '2026-03-01,claude-sonnet-4,jane@example.com,12.50,100000,5000',
      '2026-03-02,claude-sonnet-4,bob@example.com,8.00,80000,3000',
    ].join('\n');

    const result = parseAnthropicPortalCsv(csv);
    expect(result.provider).toBe('anthropic');
    expect(result.errors.filter((e) => e.line > 1)).toHaveLength(0);
    expect(result.stats.parsed).toBe(2);
    expect(result.stats.usersDetected).toBe(2);
    expect(result.stats.totalCostUsd).toBeCloseTo(20.5, 2);
    expect(result.rows[0]).toMatchObject({
      provider: 'anthropic',
      source: 'portal_import',
      user_id: 'jane@example.com',
      cost_usd: 12.5,
    });
    expect(suggestedApiSyncBaseline(result.stats.maxDay)).toBe('2026-03-03');
  });

  it('parses generic billing CSV when provider is selected explicitly', () => {
    const csv = [
      'date,project,session_id,duration,cost_usd,input_tokens,output_tokens,files_modified',
      '2026-06-01,my-app,sess_1,45m,8.45,2500,1800,12',
      '2026-06-02,my-app,sess_2,30m,4.20,1200,900,3',
    ].join('\n');

    const result = parseAnthropicPortalCsv(csv, undefined, undefined, 'cursor');
    expect(result.provider).toBe('cursor');
    expect(result.stats.parsed).toBe(2);
    expect(result.stats.totalCostUsd).toBeCloseTo(12.65, 2);
    expect(result.rows[0]).toMatchObject({
      provider: 'cursor',
      platform_display_name: 'Cursor',
      model: 'my-app',
      cost_usd: 8.45,
      user_id: 'Unassigned',
    });
  });

  it('requires provider selection for unknown billable formats', () => {
    const csv = ['When,Spend,Who', '2026-01-15,3.25,alice@co.com'].join('\n');
    const withoutProvider = parseAnthropicPortalCsv(csv, {
      date: 'When',
      cost: 'Spend',
      user: 'Who',
      costUnit: 'usd',
    });
    expect(withoutProvider.requiresProvider).toBe(true);
    expect(withoutProvider.rows).toHaveLength(0);

    const result = parseAnthropicPortalCsv(
      csv,
      {
        date: 'When',
        cost: 'Spend',
        user: 'Who',
        costUnit: 'usd',
      },
      undefined,
      'openai',
    );
    expect(result.stats.parsed).toBe(1);
    expect(result.rows[0]).toMatchObject({ provider: 'openai', user_id: 'alice@co.com', cost_usd: 3.25 });
  });

  it('converts cost from cents when mapping says cents', () => {
    const csv = ['day,amount', '2026-01-01,1250'].join('\n');
    const result = parseAnthropicPortalCsv(
      csv,
      {
        date: 'day',
        cost: 'amount',
        costUnit: 'cents',
      },
      undefined,
      'anthropic',
    );
    expect(result.rows[0]).toMatchObject({ cost_usd: 12.5, provider: 'anthropic' });
  });

  it('returns headers and suggestion when auto-detect fails', () => {
    const result = parseAnthropicPortalCsv('foo,bar\n1,2');
    expect(result.rows).toHaveLength(0);
    expect(result.requiresProvider).toBe(true);
    expect(result.headers).toEqual(['foo', 'bar']);
    expect(result.suggestion.missingRequired.length).toBeGreaterThan(0);
  });

  it('parses Anthropic spend report with user emails and report end date from filename', () => {
    const csv = [
      'user_email,account_uuid,product,model,total_net_spend_usd,user_id',
      'brandon@studiodesigner.com,113a8758-3d89-4023-83fe-7090c5c5164e,Cowork,claude-opus-4-7,19.18,user_0138PnqLyRqLRtQEqXCqEpQM',
      '(org service usage),(org service),(other),,0.0,',
    ].join('\n');
    const fileName = 'spend-report-fb01cd94-335a-4e06-80cd-af774ef7f65e-2026-03-26-to-2026-06-24.csv';
    const result = parseAnthropicPortalCsv(csv, undefined, fileName);
    expect(result.format.format).toBe('anthropic_spend_report');
    expect(result.provider).toBe('anthropic');
    expect(result.stats.parsed).toBe(1);
    expect(result.rows[0]).toMatchObject({
      user_id: 'brandon@studiodesigner.com',
      user_email: 'brandon@studiodesigner.com',
      cost_usd: 19.18,
      timestamp: '2026-06-24T12:00:00.000Z',
    });
  });

  it('rejects Cursor analytics CSV as non-billable', () => {
    const csv = ['Date,Agent Lines Total Lines Suggested', '2026-05-27,48'].join('\n');
    const result = parseAnthropicPortalCsv(csv, undefined, 'Analytics_Team_2026-05-27_2026-06-25.csv');
    expect(result.format.billable).toBe(false);
    expect(result.rows).toHaveLength(0);
  });

  it('uses stable idempotency keys independent of CSV line number', () => {
    const base = [
      'Usage Date,Model,Member Email,Cost (USD),Input Tokens,Output Tokens',
      '2026-03-01,claude-sonnet-4,jane@example.com,12.50,100000,5000',
    ];
    const withBlank = ['', ...base].join('\n');
    const a = parseAnthropicPortalCsv(base.join('\n'));
    const b = parseAnthropicPortalCsv(withBlank);
    expect(a.rows[0]?.idempotency_key).toBe(b.rows[0]?.idempotency_key);
    expect(a.rows[0]?.idempotency_key).toBe(
      portalRowIdempotencyKey('anthropic', '2026-03-01', 'jane@example.com', 'claude-sonnet-4', 12.5, 100000, 5000),
    );
    expect(a.rows[0]).toMatchObject({ cost_source: 'portal_billing', source: 'portal_import' });
  });
});

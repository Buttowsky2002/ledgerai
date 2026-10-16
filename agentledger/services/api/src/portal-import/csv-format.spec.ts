import { datesFromFileName, detectPortalCsvFormat } from './csv-format';

describe('datesFromFileName', () => {
  it('parses ISO range in spend report filename', () => {
    expect(
      datesFromFileName(
        'spend-report-fb01cd94-335a-4e06-80cd-af774ef7f65e-2026-03-26-to-2026-06-24.csv',
      ),
    ).toEqual({ from: '2026-03-26', to: '2026-06-24' });
  });

  it('parses underscore date range', () => {
    expect(datesFromFileName('Analytics_Team_2026-05-27_2026-06-25.csv')).toEqual({
      from: '2026-05-27',
      to: '2026-06-25',
    });
  });

  it('parses a single ISO date as report end', () => {
    expect(datesFromFileName('anthropic-spend-2026-08-31.csv')).toEqual({
      from: '2026-08-31',
      to: '2026-08-31',
    });
  });

  it('parses year-month as the full billing month', () => {
    expect(datesFromFileName('spend-report-2026-08.csv')).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });
});

describe('detectPortalCsvFormat', () => {
  it('detects Anthropic spend report (canonical Console export)', () => {
    const headers = [
      'user_email',
      'account_uuid',
      'product',
      'model',
      'total_requests',
      'total_prompt_tokens',
      'total_completion_tokens',
      'total_net_spend_usd',
      'total_gross_spend_usd',
      'user_id',
    ];
    const d = detectPortalCsvFormat(
      headers,
      'spend-report-fb01cd94-335a-4e06-80cd-af774ef7f65e-2026-09-01-to-2026-09-30.csv',
    );
    expect(d.format).toBe('anthropic_spend_report');
    expect(d.billable).toBe(true);
    expect(d.reportFrom).toBe('2026-09-01');
    expect(d.reportTo).toBe('2026-09-30');
  });

  it('rejects warehouse export_data.csv style dumps', () => {
    const headers = ['Table Name', 'IsBillable', 'Table Size'];
    const d = detectPortalCsvFormat(headers, 'export_data.csv');
    expect(d.format).toBe('non_billing_export');
    expect(d.billable).toBe(false);
    expect(d.hint).toMatch(/spend report/i);
  });

  it('detects Cursor analytics as non-billable', () => {
    const headers = ['Date', 'Agent Lines Total Lines Suggested', 'Chats Composer Requests'];
    const d = detectPortalCsvFormat(headers);
    expect(d.format).toBe('cursor_analytics');
    expect(d.billable).toBe(false);
  });

  it('detects Claude Code lines as non-billable', () => {
    const headers = ['User', 'Lines this Month'];
    const d = detectPortalCsvFormat(headers);
    expect(d.format).toBe('claude_code_lines');
    expect(d.billable).toBe(false);
  });
});

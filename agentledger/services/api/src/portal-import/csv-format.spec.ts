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
});

describe('detectPortalCsvFormat', () => {
  it('detects Anthropic spend report', () => {
    const headers = ['user_email', 'account_uuid', 'total_net_spend_usd', 'model'];
    const d = detectPortalCsvFormat(headers, 'spend-report-2026-03-26-to-2026-06-24.csv');
    expect(d.format).toBe('anthropic_spend_report');
    expect(d.billable).toBe(true);
    expect(d.reportTo).toBe('2026-06-24');
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

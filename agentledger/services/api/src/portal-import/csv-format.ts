/** Detected billing CSV shape — drives auto-mapping and UI warnings. */
export type PortalCsvFormat =
  | 'anthropic_spend_report'
  | 'anthropic_console'
  | 'claude_code_lines'
  | 'cursor_analytics'
  /** Warehouse / admin exports (Table Name, IsBillable, …) — never Anthropic billing. */
  | 'non_billing_export'
  | 'unknown';

export interface FormatDetection {
  format: PortalCsvFormat;
  label: string;
  billable: boolean;
  hint: string;
  /** When CSV has no per-row date (spend report), use report end from filename. */
  reportFrom: string | null;
  reportTo: string | null;
}

/** Canonical Anthropic Console “Cost & usage → Spend report” export shape. */
export const ANTHROPIC_SPEND_REPORT_HINT =
  'Upload the Anthropic Console spend report CSV (filename like spend-report-…-YYYY-MM-DD-to-YYYY-MM-DD.csv). Required columns: user_email, total_net_spend_usd (plus product, model, user_id).';

function norm(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function hasHeader(headers: string[], ...candidates: string[]): boolean {
  const set = new Set(headers.map(norm));
  return candidates.every((c) => set.has(norm(c)));
}

/** Extract YYYY-MM-DD range from common export filenames. */
export function datesFromFileName(fileName: string | undefined): {
  from: string | null;
  to: string | null;
} {
  if (!fileName) {
    return { from: null, to: null };
  }
  const isoRange = fileName.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/i);
  if (isoRange) {
    return { from: isoRange[1], to: isoRange[2] };
  }
  const isoUnderscore = fileName.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  if (isoUnderscore) {
    return { from: isoUnderscore[1], to: isoUnderscore[2] };
  }
  const usRange = fileName.match(/(\d{4})_(\d{2})_(\d{2})_to_(\d{4})_(\d{2})_(\d{2})/);
  if (usRange) {
    return {
      from: `${usRange[1]}-${usRange[2]}-${usRange[3]}`,
      to: `${usRange[4]}-${usRange[5]}-${usRange[6]}`,
    };
  }
  // Single ISO date in the name → treat as report end (Anthropic spend reports).
  const singleIso = fileName.match(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/);
  if (singleIso) {
    return { from: singleIso[1], to: singleIso[1] };
  }
  // Year-month only (2026-08 / 2026_08) → last day of that month.
  const yearMonth = fileName.match(/(?<!\d)(\d{4})[-_](\d{2})(?!\d)/);
  if (yearMonth) {
    const y = Number(yearMonth[1]);
    const m = Number(yearMonth[2]);
    if (m >= 1 && m <= 12) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const to = `${yearMonth[1]}-${yearMonth[2]}-${String(last).padStart(2, '0')}`;
      const from = `${yearMonth[1]}-${yearMonth[2]}-01`;
      return { from, to };
    }
  }
  return { from: null, to: null };
}

export function detectPortalCsvFormat(headers: string[], fileName?: string): FormatDetection {
  const fileDates = datesFromFileName(fileName);
  const looksLikeSpendFile = Boolean(fileName && /spend[-_]?report/i.test(fileName));

  if (
    hasHeader(headers, 'user_email', 'total_net_spend_usd') ||
    hasHeader(headers, 'user_email', 'total_gross_spend_usd')
  ) {
    return {
      format: 'anthropic_spend_report',
      label: 'Anthropic spend report',
      billable: true,
      hint: 'Per user/product/model rows. No daily date column — rows use the report end date from the filename.',
      reportFrom: fileDates.from,
      reportTo: fileDates.to,
    };
  }

  // Filename says spend-report but headers are wrong (common: wrong file still named for upload).
  if (
    looksLikeSpendFile &&
    !hasHeader(headers, 'user_email') &&
    !hasHeader(headers, 'total_net_spend_usd')
  ) {
    return {
      format: 'non_billing_export',
      label: 'Not an Anthropic spend report',
      billable: false,
      hint: ANTHROPIC_SPEND_REPORT_HINT,
      reportFrom: fileDates.from,
      reportTo: fileDates.to,
    };
  }

  // Warehouse / admin dumps (e.g. export_data.csv with Table Name + IsBillable).
  if (
    (hasHeader(headers, 'Table Name') && hasHeader(headers, 'IsBillable')) ||
    (hasHeader(headers, 'table_name') && hasHeader(headers, 'is_billable')) ||
    (hasHeader(headers, 'Table Name') && hasHeader(headers, 'Table Size'))
  ) {
    return {
      format: 'non_billing_export',
      label: 'Non-billing export',
      billable: false,
      hint:
        'This looks like a warehouse/admin export (Table Name / IsBillable), not Anthropic billing. ' +
        ANTHROPIC_SPEND_REPORT_HINT,
      reportFrom: fileDates.from,
      reportTo: fileDates.to,
    };
  }

  if (
    hasHeader(headers, 'Date', 'Chats Composer Requests') ||
    hasHeader(headers, 'Date', 'Agent Lines Total Lines Suggested')
  ) {
    return {
      format: 'cursor_analytics',
      label: 'Cursor team analytics',
      billable: false,
      hint: 'This is Cursor IDE usage analytics, not Anthropic billing. It has no USD spend — do not import here.',
      reportFrom: fileDates.from,
      reportTo: fileDates.to,
    };
  }

  if (
    hasHeader(headers, 'User', 'Lines this Month') ||
    hasHeader(headers, 'user', 'lines_this_month')
  ) {
    return {
      format: 'claude_code_lines',
      label: 'Claude Code lines report',
      billable: false,
      hint: 'Line counts per user only — no cost or date. ' + ANTHROPIC_SPEND_REPORT_HINT,
      reportFrom: fileDates.from,
      reportTo: fileDates.to,
    };
  }

  if (hasHeader(headers, 'usage_date', 'cost') || hasHeader(headers, 'usage date', 'cost (usd)')) {
    return {
      format: 'anthropic_console',
      label: 'Anthropic Console export',
      billable: true,
      hint: 'Standard Console billing export with date and cost per row.',
      reportFrom: fileDates.from,
      reportTo: fileDates.to,
    };
  }

  return {
    format: 'unknown',
    label: 'Unknown format',
    billable: true,
    hint: ANTHROPIC_SPEND_REPORT_HINT,
    reportFrom: fileDates.from,
    reportTo: fileDates.to,
  };
}

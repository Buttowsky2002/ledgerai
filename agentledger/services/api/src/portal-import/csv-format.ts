/** Detected billing CSV shape — drives auto-mapping and UI warnings. */
export type PortalCsvFormat =
  | 'anthropic_spend_report'
  | 'anthropic_console'
  | 'claude_code_lines'
  | 'cursor_analytics'
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

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function hasHeader(headers: string[], ...candidates: string[]): boolean {
  const set = new Set(headers.map(norm));
  return candidates.every((c) => set.has(norm(c)));
}

/** Extract YYYY-MM-DD range from common export filenames. */
export function datesFromFileName(fileName: string | undefined): { from: string | null; to: string | null } {
  if (!fileName) return { from: null, to: null };
  const isoRange = fileName.match(/(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/i);
  if (isoRange) return { from: isoRange[1], to: isoRange[2] };
  const isoUnderscore = fileName.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  if (isoUnderscore) return { from: isoUnderscore[1], to: isoUnderscore[2] };
  const usRange = fileName.match(/(\d{4})_(\d{2})_(\d{2})_to_(\d{4})_(\d{2})_(\d{2})/);
  if (usRange) {
    return {
      from: `${usRange[1]}-${usRange[2]}-${usRange[3]}`,
      to: `${usRange[4]}-${usRange[5]}-${usRange[6]}`,
    };
  }
  return { from: null, to: null };
}

export function detectPortalCsvFormat(headers: string[], fileName?: string): FormatDetection {
  const fileDates = datesFromFileName(fileName);

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

  if (hasHeader(headers, 'User', 'Lines this Month') || hasHeader(headers, 'user', 'lines_this_month')) {
    return {
      format: 'claude_code_lines',
      label: 'Claude Code lines report',
      billable: false,
      hint: 'Line counts per user only — no cost or date. Use the Anthropic spend report CSV for billing.',
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
    hint: 'Map Date and Cost manually, or use an Anthropic spend report export.',
    reportFrom: fileDates.from,
    reportTo: fileDates.to,
  };
}

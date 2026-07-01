import { createHash } from 'node:crypto';
import {
  type ColumnMappingByName,
  findHeaderRowIndex,
  resolveColumnMapping,
  suggestColumnMapping,
  type MappingSuggestion,
  type ResolvedColumnMapping,
} from './column-mapping';
import { detectPortalCsvFormat, type FormatDetection } from './csv-format';
import { detectDelimiter, parseCsv, stripBom } from './csv-parse';

export const PORTAL_IMPORT_SOURCE = 'portal_import';

export interface PortalParseResult {
  headers: string[];
  headerRow: number;
  delimiter: string;
  format: FormatDetection;
  suggestion: MappingSuggestion;
  mappingUsed: ColumnMappingByName | null;
  rows: Record<string, unknown>[];
  errors: { line: number; message: string }[];
  preview: Record<string, unknown>[];
  stats: {
    parsed: number;
    skipped: number;
    skippedZeroCost: number;
    minDay: string | null;
    maxDay: string | null;
    usersDetected: number;
    totalCostUsd: number;
    dataRows: number;
  };
}

function dayAfter(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseCost(raw: string, unit: 'usd' | 'cents'): number | undefined {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const usd = unit === 'cents' ? n / 100 : n;
  return usd > 0 ? usd : undefined;
}

function parseDay(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

function idempotencyKey(day: string, user: string, model: string, cost: number, line: number): string {
  const raw = `portal:anthropic:${day}:${user}:${model}:${cost.toFixed(6)}:${line}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function mappingFromSuggestion(
  suggestion: MappingSuggestion,
  format: FormatDetection,
): ColumnMappingByName | null {
  if (!format.billable) return null;
  const m = suggestion.mapping;
  if (!m.cost) return null;
  if (!m.date && !m.reportThroughDay && !format.reportTo) return null;
  return {
    cost: m.cost,
    costUnit: m.costUnit ?? suggestion.inferredCostUnit,
    ...(m.date ? { date: m.date } : {}),
    reportThroughDay: m.reportThroughDay ?? format.reportTo ?? undefined,
    model: m.model,
    product: m.product,
    user: m.user,
    user_name: m.user_name,
    user_id: m.user_id,
    account_uuid: m.account_uuid,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
  };
}

function resolveUserFields(
  cells: string[],
  mapping: ResolvedColumnMapping,
): { label: string; email?: string; providerUserId?: string; uuid?: string; name?: string } {
  const email = (mapping.user >= 0 ? (cells[mapping.user] ?? '').trim() : '') || '';
  const name = mapping.user_name >= 0 ? (cells[mapping.user_name] ?? '').trim() : '';
  const providerUserId = mapping.user_id >= 0 ? (cells[mapping.user_id] ?? '').trim() : '';
  const uuid = mapping.account_uuid >= 0 ? (cells[mapping.account_uuid] ?? '').trim() : '';

  const isOrg = email.toLowerCase().includes('org service') || email === '(org service usage)';
  if (isOrg) return { label: '' };

  const label =
    (email && email.includes('@') ? email : '') ||
    (providerUserId && providerUserId.startsWith('user_') ? providerUserId : '') ||
    (uuid && uuid.includes('-') ? uuid : '') ||
    email ||
    name ||
    providerUserId ||
    'Unassigned';

  return {
    label,
    ...(email && email.includes('@') ? { email } : {}),
    ...(providerUserId ? { providerUserId } : {}),
    ...(uuid ? { uuid } : {}),
    ...(name ? { name } : {}),
  };
}

function parseGrid(
  grid: string[][],
  headerRow: number,
  mapping: ResolvedColumnMapping,
): Omit<
  PortalParseResult,
  'headers' | 'headerRow' | 'delimiter' | 'format' | 'suggestion' | 'mappingUsed'
> {
  const errors: { line: number; message: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const users = new Set<string>();
  let minDay: string | null = null;
  let maxDay: string | null = null;
  let totalCostUsd = 0;
  let skipped = 0;
  let skippedZeroCost = 0;
  let dataRows = 0;

  for (let i = headerRow + 1; i < grid.length; i++) {
    const cells = grid[i];
    const line = i + 1;
    if (cells.every((c) => !c.trim())) continue;
    dataRows++;

    const day =
      mapping.date >= 0
        ? parseDay(cells[mapping.date] ?? '')
        : mapping.reportThroughDay
          ? mapping.reportThroughDay
          : undefined;
    const cost = parseCost(cells[mapping.cost] ?? '', mapping.costUnit);

    if (!day) {
      skipped++;
      if (errors.length < 20) errors.push({ line, message: 'invalid or missing date' });
      continue;
    }
    if (cost === undefined) {
      skipped++;
      skippedZeroCost++;
      continue;
    }

    const userFields = resolveUserFields(cells, mapping);
    if (!userFields.label) {
      skipped++;
      continue;
    }

    const product = mapping.product >= 0 ? (cells[mapping.product] ?? '').trim() : '';
    const modelRaw = mapping.model >= 0 ? (cells[mapping.model] ?? '').trim() : '';
    const model = modelRaw || product || 'unknown';
    const userLabel = userFields.label;

    if (userLabel !== 'Unassigned') users.add(userLabel);
    totalCostUsd += cost;
    if (!minDay || day < minDay) minDay = day;
    if (!maxDay || day > maxDay) maxDay = day;

    const row: Record<string, unknown> = {
      idempotency_key: idempotencyKey(day, userLabel, model, cost, line),
      timestamp: `${day}T12:00:00.000Z`,
      provider: 'anthropic',
      platform_display_name: 'Anthropic',
      model,
      cost_usd: cost,
      user_id: userLabel,
      source: PORTAL_IMPORT_SOURCE,
      status: 'ok',
    };
    if (userFields.email) row.user_email = userFields.email;
    if (userFields.name) row.user_name = userFields.name;
    if (userFields.providerUserId) row.provider_user_id = userFields.providerUserId;
    if (userFields.uuid) row.account_uuid = userFields.uuid;
    if (mapping.input_tokens >= 0 && cells[mapping.input_tokens]) {
      row.input_tokens = Number(cells[mapping.input_tokens]) || 0;
    }
    if (mapping.output_tokens >= 0 && cells[mapping.output_tokens]) {
      row.output_tokens = Number(cells[mapping.output_tokens]) || 0;
    }

    rows.push(row);
  }

  return {
    rows,
    errors,
    preview: rows.slice(0, 8),
    stats: {
      parsed: rows.length,
      skipped,
      skippedZeroCost,
      minDay,
      maxDay,
      usersDetected: users.size,
      totalCostUsd,
      dataRows,
    },
  };
}

/** Parse CSV grid with optional user mapping (preview + import). */
export function parseAnthropicPortalCsv(
  csvText: string,
  userMapping?: ColumnMappingByName,
  fileName?: string,
): PortalParseResult {
  const cleaned = stripBom(csvText.trim());
  const delimiter = detectDelimiter(cleaned);
  const grid = parseCsv(cleaned, delimiter);
  const emptyStats = {
    parsed: 0,
    skipped: 0,
    skippedZeroCost: 0,
    minDay: null,
    maxDay: null,
    usersDetected: 0,
    totalCostUsd: 0,
    dataRows: 0,
  };

  if (grid.length < 1) {
    const emptyFormat = detectPortalCsvFormat([], fileName);
    return {
      headers: [],
      headerRow: 0,
      delimiter,
      format: emptyFormat,
      suggestion: suggestColumnMapping([]),
      mappingUsed: null,
      rows: [],
      errors: [{ line: 1, message: 'CSV is empty' }],
      preview: [],
      stats: emptyStats,
    };
  }

  const headerRow = findHeaderRowIndex(grid);
  const headers = grid[headerRow];
  const format = detectPortalCsvFormat(headers, fileName);
  const suggestion = suggestColumnMapping(headers, {
    format: format.format,
    fileName,
    reportThroughDay: format.reportTo,
  });
  const mappingByName = userMapping ?? mappingFromSuggestion(suggestion, format);

  if (!format.billable) {
    return {
      headers,
      headerRow,
      delimiter,
      format,
      suggestion,
      mappingUsed: null,
      rows: [],
      errors: [{ line: headerRow + 1, message: format.hint }],
      preview: [],
      stats: emptyStats,
    };
  }

  if (!mappingByName) {
    const errors = suggestion.missingRequired.map((r) => ({
      line: headerRow + 1,
      message: `could not auto-detect ${r} column — map it manually`,
    }));
    return {
      headers,
      headerRow,
      delimiter,
      format,
      suggestion,
      mappingUsed: null,
      rows: [],
      errors,
      preview: [],
      stats: emptyStats,
    };
  }

  const { resolved, error } = resolveColumnMapping(headers, mappingByName);
  if (!resolved || error) {
    return {
      headers,
      headerRow,
      delimiter,
      format,
      suggestion,
      mappingUsed: mappingByName,
      rows: [],
      errors: [{ line: headerRow + 1, message: error ?? 'invalid column mapping' }],
      preview: [],
      stats: emptyStats,
    };
  }

  const parsed = parseGrid(grid, headerRow, resolved);
  return {
    headers,
    headerRow,
    delimiter,
    format,
    suggestion,
    mappingUsed: mappingByName,
    ...parsed,
  };
}

export function suggestedApiSyncBaseline(maxPortalDay: string | null): string | null {
  return maxPortalDay ? dayAfter(maxPortalDay) : null;
}

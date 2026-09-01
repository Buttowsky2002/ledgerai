import type { PortalParseResult } from './anthropic-portal.parser';
import type { ColumnMappingByName } from './column-mapping';
import { providerModelConflictMessage, type ProviderModelConflict } from './provider-model-guard';

// Pure result-shaping helpers extracted verbatim from PortalImportService. The
// service keeps all Prisma/import-service I/O; these functions only build the
// PortalFileResult / PortalPreviewResult response objects from an already-parsed
// CSV, so uploadAnthropicBatch no longer inlines four near-identical object
// literals and each shape is unit-testable in isolation.

export interface PortalFileResult {
  fileName: string;
  parsed: number;
  skipped: number;
  skippedZeroCost: number;
  imported: number;
  duplicateSkipped: number;
  usersDetected: number;
  totalCostUsd: number;
  dateRange: { from: string | null; to: string | null };
  parseErrors: { line: number; message: string }[];
  preview: Record<string, unknown>[];
  headers: string[];
  mappingUsed: ColumnMappingByName | null;
  ok: boolean;
  error?: string;
}

export interface PortalPreviewResult {
  fileName?: string;
  headers: string[];
  headerRow: number;
  delimiter: string;
  format: PortalParseResult['format'];
  suggestion: PortalParseResult['suggestion'];
  mapping: ColumnMappingByName | null;
  provider: string | null;
  requiresProvider: boolean;
  /** Models contradicting the stamped provider — non-empty blocks the import. */
  providerConflicts: ProviderModelConflict[];
  providerConflictMessage?: string;
  importable: boolean;
  parsed: number;
  skipped: number;
  skippedZeroCost: number;
  usersDetected: number;
  totalCostUsd: number;
  dateRange: { from: string | null; to: string | null };
  parseErrors: { line: number; message: string }[];
  preview: Record<string, unknown>[];
  sampleRawRows: string[][];
}

/** An empty upload file — no parse ran, so stats are zero and metadata is blank. */
export function buildEmptyFileResult(fileName: string): PortalFileResult {
  return {
    fileName,
    parsed: 0,
    skipped: 0,
    skippedZeroCost: 0,
    imported: 0,
    duplicateSkipped: 0,
    usersDetected: 0,
    totalCostUsd: 0,
    dateRange: { from: null, to: null },
    parseErrors: [{ line: 1, message: 'file is empty' }],
    preview: [],
    headers: [],
    mappingUsed: null,
    ok: false,
    error: 'file is empty',
  };
}

/**
 * A parsed-but-not-imported file (missing provider, provider/model conflict, or
 * no importable rows). Carries the parse diagnostics so the UI can explain why.
 */
export function buildRejectedFileResult(
  fileName: string,
  parsed: PortalParseResult,
  error: string,
): PortalFileResult {
  return {
    fileName,
    parsed: 0,
    skipped: parsed.stats.skipped,
    skippedZeroCost: parsed.stats.skippedZeroCost,
    imported: 0,
    duplicateSkipped: 0,
    usersDetected: 0,
    totalCostUsd: 0,
    dateRange: { from: parsed.stats.minDay, to: parsed.stats.maxDay },
    parseErrors: parsed.errors,
    preview: parsed.preview,
    headers: parsed.headers,
    mappingUsed: parsed.mappingUsed,
    ok: false,
    error,
  };
}

/** A file whose rows will be imported (imported count is stamped later by the caller). */
export function buildImportedFileResult(
  fileName: string,
  parsed: PortalParseResult,
): PortalFileResult {
  return {
    fileName,
    parsed: parsed.stats.parsed,
    skipped: parsed.stats.skipped,
    skippedZeroCost: parsed.stats.skippedZeroCost,
    imported: 0,
    duplicateSkipped: 0,
    usersDetected: parsed.stats.usersDetected,
    totalCostUsd: parsed.stats.totalCostUsd,
    dateRange: { from: parsed.stats.minDay, to: parsed.stats.maxDay },
    parseErrors: parsed.errors,
    preview: parsed.preview,
    headers: parsed.headers,
    mappingUsed: parsed.mappingUsed,
    ok: true,
  };
}

export function extractSampleRawRows(
  csvText: string,
  parsed: Pick<PortalParseResult, 'headerRow' | 'delimiter'>,
): string[][] {
  const sampleRawRows: string[][] = [];

  // Re-parse for raw samples (lightweight — preview only)

  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .slice(parsed.headerRow, parsed.headerRow + 6);

  for (let i = 1; i < lines.length && sampleRawRows.length < 5; i++) {
    sampleRawRows.push(lines[i]?.split(parsed.delimiter === '\t' ? '\t' : parsed.delimiter) ?? []);
  }

  return sampleRawRows;
}

export function buildPortalPreviewResult(
  parsed: PortalParseResult,
  sampleRawRows: string[][],
  fileName?: string,
): PortalPreviewResult {
  return {
    fileName,
    headers: parsed.headers,
    headerRow: parsed.headerRow,
    delimiter: parsed.delimiter,
    format: parsed.format,
    suggestion: parsed.suggestion,

    mapping: parsed.mappingUsed,
    provider: parsed.provider,
    requiresProvider: parsed.requiresProvider,
    providerConflicts: parsed.providerConflicts,
    providerConflictMessage:
      parsed.providerConflicts.length > 0
        ? providerModelConflictMessage(parsed.provider ?? 'unknown', parsed.providerConflicts)
        : undefined,

    importable: parsed.rows.length > 0 && parsed.providerConflicts.length === 0,

    parsed: parsed.stats.parsed,

    skipped: parsed.stats.skipped,

    skippedZeroCost: parsed.stats.skippedZeroCost,

    usersDetected: parsed.stats.usersDetected,

    totalCostUsd: parsed.stats.totalCostUsd,

    dateRange: { from: parsed.stats.minDay, to: parsed.stats.maxDay },

    parseErrors: parsed.errors,

    preview: parsed.preview,

    sampleRawRows,
  };
}

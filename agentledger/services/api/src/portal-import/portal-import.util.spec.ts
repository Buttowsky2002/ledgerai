import type { PortalParseResult } from './anthropic-portal.parser';
import {
  buildEmptyFileResult,
  buildImportedFileResult,
  buildPortalPreviewResult,
  buildRejectedFileResult,
  extractSampleRawRows,
} from './portal-import.util';

function makeParsed(overrides: Partial<PortalParseResult> = {}): PortalParseResult {
  return {
    headers: ['date', 'model', 'cost'],
    headerRow: 0,
    delimiter: ',',
    format: {} as PortalParseResult['format'],
    suggestion: {} as PortalParseResult['suggestion'],
    mappingUsed: null,
    provider: 'anthropic',
    requiresProvider: false,
    rows: [{ user_id: 'u1' }],
    providerConflicts: [],
    errors: [{ line: 2, message: 'bad row' }],
    preview: [{ date: '2026-06-01' }],
    stats: {
      parsed: 3,
      skipped: 1,
      skippedZeroCost: 1,
      minDay: '2026-06-01',
      maxDay: '2026-06-30',
      usersDetected: 2,
      totalCostUsd: 123.45,
      dataRows: 4,
    },
    ...overrides,
  } as unknown as PortalParseResult;
}

describe('buildEmptyFileResult', () => {
  it('returns a blank, not-ok result flagged as an empty file', () => {
    const result = buildEmptyFileResult('x.csv');
    expect(result).toEqual({
      fileName: 'x.csv',
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
    });
  });
});

describe('buildRejectedFileResult', () => {
  it('carries parse diagnostics with the supplied error and parsed=0', () => {
    const parsed = makeParsed();
    const result = buildRejectedFileResult(
      'x.csv',
      parsed,
      'select a billing provider for this file',
    );
    expect(result.ok).toBe(false);
    expect(result.parsed).toBe(0);
    expect(result.error).toBe('select a billing provider for this file');
    expect(result.skipped).toBe(1);
    expect(result.skippedZeroCost).toBe(1);
    expect(result.dateRange).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(result.parseErrors).toBe(parsed.errors);
    expect(result.preview).toBe(parsed.preview);
    expect(result.headers).toBe(parsed.headers);
  });
});

describe('buildImportedFileResult', () => {
  it('reports parsed stats and marks the file ok with no error', () => {
    const parsed = makeParsed();
    const result = buildImportedFileResult('x.csv', parsed);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.parsed).toBe(3);
    expect(result.usersDetected).toBe(2);
    expect(result.totalCostUsd).toBe(123.45);
    expect(result.dateRange).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });
});

describe('extractSampleRawRows', () => {
  it('returns up to five data rows split on the delimiter, skipping the header line', () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6\n7,8,9';
    const rows = extractSampleRawRows(csv, { headerRow: 0, delimiter: ',' });
    expect(rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
    ]);
  });

  it('splits on tabs when the delimiter is a tab', () => {
    const csv = 'a\tb\n1\t2\n3\t4';
    const rows = extractSampleRawRows(csv, { headerRow: 0, delimiter: '\t' });
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('caps the sample at five rows', () => {
    const csv = ['h', '1', '2', '3', '4', '5', '6', '7'].join('\n');
    const rows = extractSampleRawRows(csv, { headerRow: 0, delimiter: ',' });
    expect(rows.length).toBe(5);
  });
});

describe('buildPortalPreviewResult', () => {
  it('marks importable and omits the conflict message when there are no conflicts', () => {
    const parsed = makeParsed();
    const result = buildPortalPreviewResult(parsed, [['1', '2', '3']], 'x.csv');
    expect(result.fileName).toBe('x.csv');
    expect(result.importable).toBe(true);
    expect(result.providerConflictMessage).toBeUndefined();
    expect(result.sampleRawRows).toEqual([['1', '2', '3']]);
    expect(result.dateRange).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('is not importable when there are no rows', () => {
    const parsed = makeParsed({ rows: [] });
    const result = buildPortalPreviewResult(parsed, [], undefined);
    expect(result.importable).toBe(false);
  });
});

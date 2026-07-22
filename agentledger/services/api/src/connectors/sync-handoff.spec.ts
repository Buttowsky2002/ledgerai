import {
  readConnectorHandoff,
  resolveConnectorSyncRange,
  resolveFirstSyncBaseline,
  shouldLockApiSyncBaseline,
} from './sync-handoff';

describe('sync-handoff', () => {
  it('clamps sync from date to apiSyncBaselineFrom when to is on or after baseline', () => {
    const range = resolveConnectorSyncRange(
      { from: '2026-01-01', to: '2026-06-01' },
      { apiSyncBaselineFrom: '2026-04-01' },
    );
    expect(range).toEqual({ from: '2026-04-01', to: '2026-06-01' });
  });

  it('allows manual re-backfill when to is before apiSyncBaselineFrom', () => {
    const range = resolveConnectorSyncRange(
      { from: '2026-06-08', to: '2026-07-08' },
      { apiSyncBaselineFrom: '2026-07-09' },
    );
    expect(range).toEqual({ from: '2026-06-08', to: '2026-07-08' });
  });

  it('skips incremental sync when window ends before apiSyncBaselineFrom', () => {
    const range = resolveConnectorSyncRange(
      { from: '2026-07-06', to: '2026-07-08' },
      { apiSyncBaselineFrom: '2026-07-09' },
      { incremental: true },
    );
    expect(range).toBeNull();
  });

  it('defaults API sync to baseline through today when no range given', () => {
    const today = new Date().toISOString().slice(0, 10);
    const range = resolveConnectorSyncRange(undefined, { apiSyncBaselineFrom: '2026-04-01' });
    expect(range).toEqual({ from: '2026-04-01', to: today });
  });

  it('reads portal handoff fields from connector config', () => {
    expect(
      readConnectorHandoff({
        portalImportThrough: '2026-03-31',
        apiSyncBaselineFrom: '2026-04-01',
      }),
    ).toEqual({
      portalImportThrough: '2026-03-31',
      apiSyncBaselineFrom: '2026-04-01',
    });
  });

  it('sets first sync baseline day after portal coverage', () => {
    expect(resolveFirstSyncBaseline('2026-03-31', '2026-06-01')).toBe('2026-04-01');
  });

  it('sets first sync baseline day after sync end when no portal import', () => {
    expect(resolveFirstSyncBaseline(null, '2026-06-01')).toBe('2026-06-02');
  });

  it('locks baseline only after a full backfill (or portal handoff)', () => {
    expect(
      shouldLockApiSyncBaseline({
        portalImportThrough: '2026-03-31',
        coveredDays: 3,
        defaultBackfillDays: 90,
      }),
    ).toBe(true);
    expect(
      shouldLockApiSyncBaseline({
        portalImportThrough: null,
        coveredDays: 3,
        defaultBackfillDays: 90,
      }),
    ).toBe(false);
    expect(
      shouldLockApiSyncBaseline({
        portalImportThrough: null,
        coveredDays: 90,
        defaultBackfillDays: 90,
      }),
    ).toBe(true);
    expect(
      shouldLockApiSyncBaseline({
        portalImportThrough: null,
        coveredDays: 89,
        defaultBackfillDays: 90,
      }),
    ).toBe(true);
  });
});

import { shouldSurfaceLegacyImportAudit } from './legacy-import-list';

describe('shouldSurfaceLegacyImportAudit', () => {
  it('hides an audit whose importRunId belongs to a soft-deleted portal run', () => {
    // Pilot bug: after deleting 95dcb36b, the audit resurrected as Legacy.
    expect(
      shouldSurfaceLegacyImportAudit({
        auditId: 378,
        importRunId: '95dcb36b-245c-49ab-ac6d-39153f722099',
        knownRunIds: new Set(['95dcb36b-245c-49ab-ac6d-39153f722099']),
        purgedAuditIds: new Set(),
      }),
    ).toBe(false);
  });

  it('hides an audit that was already purged via the legacy Delete path', () => {
    expect(
      shouldSurfaceLegacyImportAudit({
        auditId: 378,
        importRunId: null,
        knownRunIds: new Set(),
        purgedAuditIds: new Set(['378']),
      }),
    ).toBe(false);
  });

  it('surfaces a true pre-tracking legacy import that has not been purged', () => {
    expect(
      shouldSurfaceLegacyImportAudit({
        auditId: 100,
        importRunId: null,
        knownRunIds: new Set(['other-run']),
        purgedAuditIds: new Set(['99']),
      }),
    ).toBe(true);
  });

  it('surfaces an audit whose importRunId is unknown (run row never written)', () => {
    expect(
      shouldSurfaceLegacyImportAudit({
        auditId: 200,
        importRunId: 'missing-run',
        knownRunIds: new Set(),
        purgedAuditIds: new Set(),
      }),
    ).toBe(true);
  });
});

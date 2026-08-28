/**
 * Decide whether an import audit_log row should appear as a Legacy entry in
 * Import History. Pure so the "ghost after delete" regression stays covered.
 */
export function shouldSurfaceLegacyImportAudit(opts: {
  auditId: string | number | bigint;
  importRunId: string | null;
  /** Every portal_import_runs id for the tenant, including soft-deleted. */
  knownRunIds: Set<string>;
  /** Audit ids already purged via Delete (object portal-import:audit:<id>). */
  purgedAuditIds: Set<string>;
}): boolean {
  if (opts.importRunId && opts.knownRunIds.has(opts.importRunId)) {return false;}
  if (opts.purgedAuditIds.has(String(opts.auditId))) {return false;}
  return true;
}

/**
 * Synthetic Acme demo identities from older seeds. They must never appear in
 * live Users / roster / Settings — even if historical ClickHouse rows still
 * reference @acme.test user_ids.
 */
export function isDemoIdentityKey(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const v = value.trim().toLowerCase();
  if (!v) {
    return false;
  }
  if (v.endsWith('@acme.test')) {
    return true;
  }
  // Legacy ClickHouse demo handles that were mapped to @acme.test humans.
  if (/^demo-user-\d+$/.test(v)) {
    return true;
  }
  return false;
}

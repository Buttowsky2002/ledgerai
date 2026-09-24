/**
 * Collect Anthropic/OpenAI expense-report emails that should receive a basic
 * seat license. Premium tags are preserved by the caller (never downgraded).
 */
export function seatVendorsFromImportRows(
  rows: Record<string, unknown>[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const provider = String(row.provider ?? '')
      .trim()
      .toLowerCase();
    if (provider !== 'anthropic' && provider !== 'openai') {
      continue;
    }
    const emailFromCol =
      typeof row.user_email === 'string' ? row.user_email.trim().toLowerCase() : '';
    const emailFromUserId =
      typeof row.user_id === 'string' && String(row.user_id).includes('@')
        ? String(row.user_id).trim().toLowerCase()
        : '';
    const email = emailFromCol.includes('@') ? emailFromCol : emailFromUserId;
    if (!email || !email.includes('@')) {
      continue;
    }
    const vendors = out.get(email) ?? new Set<string>();
    vendors.add(provider);
    out.set(email, vendors);
  }
  return out;
}

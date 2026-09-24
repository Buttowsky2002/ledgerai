/** Shared identity filters — kept out of 'use client' modules so Server Components can call them. */

/** Demo / synthetic emails and handles that must never appear in live member lists. */
export function isDemoIdentityEmail(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  const v = email.trim().toLowerCase();
  if (v.endsWith('@acme.test')) {
    return true;
  }
  if (/^demo-user-\d+$/.test(v)) {
    return true;
  }
  return false;
}

/** True when a Users-directory row is a leftover Acme / demo synthetic identity. */
export function isDemoUserRow(user: { user_id?: string | null; email?: string | null }): boolean {
  return isDemoIdentityEmail(user.email) || isDemoIdentityEmail(user.user_id);
}

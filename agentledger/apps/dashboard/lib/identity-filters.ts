/** Shared identity filters — kept out of 'use client' modules so Server Components can call them. */

/** Demo / synthetic emails that must never appear in the live team list. */
export function isDemoIdentityEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith('@acme.test');
}

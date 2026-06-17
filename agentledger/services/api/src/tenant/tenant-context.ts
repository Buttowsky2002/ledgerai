import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenant context. The resolved tenant id is bound to the async
 * execution of a single request via AsyncLocalStorage, so handlers and the
 * Prisma tenant-scoped transaction can read it without threading it through
 * every call. Until OIDC/JWT lands (Phase 3 task 2), the id is populated by
 * TenantMiddleware from a dev-trusted header; afterwards from JWT claims.
 */
export interface TenantStore {
  /** Tenant UUID for this request, or null when unauthenticated. */
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<TenantStore>();

/** Run `fn` with the given tenant id bound to the current async context. */
export function runWithTenant<T>(tenantId: string | null, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/** The tenant id bound to the current request, or null if none/outside a request. */
export function getTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

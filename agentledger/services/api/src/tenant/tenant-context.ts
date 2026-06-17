import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request principal. Bound to the async execution of a single request via
 * AsyncLocalStorage so handlers, guards, and the Prisma tenant-scoped transaction
 * can read it without threading it through every call.
 *
 * Populated by AuthMiddleware from a verified access JWT (or, in dev, the
 * x-tenant-id header behind AGENTLEDGER_DEV_TRUST_HEADER). The `tenantId` feeds
 * the RLS chain (set_config('app.tenant_id', …)); `role` drives RBAC.
 */
export interface Principal {
  /** Tenant UUID, or null when unauthenticated. */
  tenantId: string | null;
  /** Identity UUID, or null (dev principal / unauthenticated). */
  userId: string | null;
  /** API role: viewer | analyst | admin, or null when unauthenticated. */
  role: string | null;
}

const storage = new AsyncLocalStorage<Principal>();

/** Run `fn` with the given principal bound to the current async context. */
export function runWithTenant<T>(principal: Principal, fn: () => T): T {
  return storage.run(principal, fn);
}

/** The principal bound to the current request, or null outside a request. */
export function getPrincipal(): Principal | null {
  return storage.getStore() ?? null;
}

/** Convenience: the current request's tenant id (null if none). */
export function getTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

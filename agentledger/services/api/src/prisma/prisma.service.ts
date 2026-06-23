import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../env';

/**
 * Prisma client wired for Postgres row-level security.
 *
 * `withTenant` runs all DB work for a request inside a single interactive
 * transaction whose first statement binds `app.tenant_id` with set_config(...,
 * true) — i.e. SET LOCAL, scoped to *this* transaction only. This is what makes
 * RLS safe under connection pooling: a plain `SET` would persist on the pooled
 * connection and leak one tenant's context into the next request that reuses it.
 * Transaction-local binding makes that leak impossible.
 *
 * A null/empty tenant id binds the empty string; the RLS policies use
 * nullif(current_setting('app.tenant_id', true), '')::uuid, so absent context
 * yields NULL and every row predicate is false (fail closed).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Resolve the connection string at runtime, preferring the new LEDGERAI_PG_DSN
    // and falling back to the legacy AGENTLEDGER_PG_DSN alias (deprecated). This
    // override is the backwards-compatible source of truth — Prisma's own env()
    // in schema.prisma has no alias fallback.
    const url = env('LEDGERAI_PG_DSN');
    super(url ? { datasources: { db: { url } } } : {});
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Execute `fn` with `app.tenant_id` bound for the life of one transaction. */
  async withTenant<T>(
    tenantId: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parameterised: tenantId is bound, never concatenated.
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId ?? ''}, true)`;
      return fn(tx);
    });
  }
}

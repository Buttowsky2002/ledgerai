import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../env';

/**
 * Tenant data-deletion job (security rule 14): erase a tenant from both stores.
 *
 *   npm run delete-tenant -- <tenant-uuid>
 *
 * Postgres: delete the tenant row (every tenant table has ON DELETE CASCADE, so
 * children go with it) plus audit_log (no FK). ClickHouse: ALTER ... DELETE on
 * each tenant-scoped data table, synchronously (mutations_sync=1) so it's
 * verifiable. Destructive and irreversible — there is no UI trigger.
 */

// ClickHouse data tables holding per-tenant rows (views derive from these).
const CH_TABLES = [
  'llm_calls',
  'agent_runs',
  'outcomes',
  'provider_costs',
  'cost_adjustments',
  'spend_daily',
  'spend_hourly_by_key',
  'risk_daily',
];

async function main(): Promise<void> {
  const tenantId = process.argv[2] ?? env('LEDGERAI_DELETE_TENANT_ID');
  if (!tenantId) {
    process.stderr.write('usage: delete-tenant <tenant-uuid>\n');
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const clickhouse = app.get(ClickHouseService);

  // Postgres: audit_log has no FK to tenants, so clear it explicitly; deleting the
  // tenant row cascades to all child tables. Done in the tenant's RLS context.
  const pg = await prisma.withTenant(tenantId, async (tx) => {
    await tx.auditLog.deleteMany({});
    return tx.tenant.deleteMany({ where: { tenantId } });
  });

  // ClickHouse: synchronous ALTER DELETE per data table (parameterized).
  for (const table of CH_TABLES) {
    await clickhouse.command(
      `ALTER TABLE agentledger.${table} DELETE WHERE tenant_id = {tenant:String} SETTINGS mutations_sync = 1`,
      { tenant: tenantId },
    );
  }

  await app.close();

  // Structured audit line — the tenant's own audit_log is gone, so this is the record.
  process.stdout.write(
    `${JSON.stringify({
      event: 'tenant.deleted',
      tenant_id: tenantId,
      postgres_tenant_rows_deleted: pg.count,
      clickhouse_tables: CH_TABLES,
      at: new Date().toISOString(),
    })}\n`,
  );
}

void main();

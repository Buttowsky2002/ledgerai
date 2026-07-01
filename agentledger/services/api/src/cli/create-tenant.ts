import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../env';

/**
 * Tenant creation CLI (ADR-012: tenant provisioning is cross-tenant and RLS-blocked,
 * so it lives on a CLI path only — never a REST endpoint). Mirrors delete-tenant.ts:
 * same NestFactory.createApplicationContext bootstrap, same single structured JSON
 * line on stdout, same exit codes.
 *
 *   npm run create-tenant -- --name "Acme Corp" --region us --plan trial
 *   BADGERIQ_TENANT_NAME="Acme Corp" npm run create-tenant   # (BADGERIQ_ / BADGERIQ_ prefixes also resolve)
 *
 * RLS note: the tenants table has FORCE ROW LEVEL SECURITY with
 * WITH CHECK (tenant_id = app_current_tenant()) (002_rls.sql), and the API connects
 * as the non-BYPASSRLS agentledger_api role. A context-less INSERT would therefore be
 * rejected. So we mint the UUID here and run the whole create inside withTenant(newId):
 * the tenant row and its children all satisfy the check because tenant_id = newId =
 * app_current_tenant().
 *
 * Smoke test (not unit-testable without a live DB, same as delete-tenant.ts):
 *   npm run build && npm run create-tenant -- --name "Smoke Co" --plan trial
 *   → one tenant.created JSON line; verify: SELECT * FROM tenants WHERE name='Smoke Co';
 */

const PLANS = ['trial', 'team', 'enterprise'] as const;

/** Read `--flag value` from argv. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

async function main(): Promise<void> {
  const name = flag('name') ?? env('BADGERIQ_TENANT_NAME');
  const region = flag('region') ?? env('BADGERIQ_TENANT_REGION') ?? 'us';
  const plan = flag('plan') ?? env('BADGERIQ_TENANT_PLAN') ?? 'trial';

  if (!name) {
    process.stderr.write(
      'usage: create-tenant --name <name> [--region us] [--plan trial|team|enterprise]\n',
    );
    process.exit(2);
  }
  if (!(PLANS as readonly string[]).includes(plan)) {
    process.stderr.write(`invalid --plan '${plan}' (must be one of ${PLANS.join('|')})\n`);
    process.exit(2);
  }

  const tenantId = randomUUID();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  const teamId = await prisma.withTenant(tenantId, async (tx) => {
    // Explicit tenantId so the row satisfies the tenants WITH CHECK under our own context.
    await tx.tenant.create({ data: { tenantId, name, region, plan } });
    const team = await tx.team.create({ data: { tenantId, name: 'Default' } });
    return team.teamId;
  });

  await app.close();

  process.stdout.write(
    `${JSON.stringify({
      event: 'tenant.created',
      tenant_id: tenantId,
      tenant_name: name,
      team_id: teamId,
      plan,
      at: new Date().toISOString(),
    })}\n`,
  );
}

void main();

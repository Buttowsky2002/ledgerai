import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../env';

/**
 * Full tenant onboarding CLI (ADR-012: cross-tenant + RLS-blocked → CLI only, never a
 * REST endpoint). Creates everything a new customer needs to log in and start:
 * tenant → Default team → admin identity → first virtual key, all audited. Bootstrap
 * pattern is duplicated from create-tenant.ts (not imported) for clarity.
 *
 *   npm run provision-tenant -- --name "Acme Corp" --admin-email "alice@acme.com" --plan team
 *
 * RLS note (same as create-tenant.ts): the tenants table is FORCE ROW LEVEL SECURITY
 * with WITH CHECK (tenant_id = app_current_tenant()) and the API is the non-BYPASSRLS
 * agentledger_api role, so we mint the UUID here and run the whole sequence inside a
 * single withTenant(tenantId) transaction — every row's tenant_id equals the bound
 * context and passes the check.
 *
 * Security: the virtual key plaintext appears only in the stdout JSON below — never in
 * the DB, never in audit detail, never anywhere else (security rule 6).
 *
 * Smoke test (not unit-testable without a live DB, same as delete-tenant.ts):
 *   npm run build && npm run provision-tenant -- --name "Smoke Co" --admin-email a@smoke.co
 *   → one tenant.provisioned JSON line; copy virtual_key (shown once).
 */

const PLANS = ['trial', 'team', 'enterprise'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read `--flag value` from argv. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

/** SHA-256 hex — mirrors VirtualKeysService.sha256hex / the gateway's keys.go. */
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main(): Promise<void> {
  const name = flag('name') ?? env('BADGERIQ_TENANT_NAME');
  const adminEmail = flag('admin-email') ?? env('BADGERIQ_TENANT_ADMIN_EMAIL');
  const region = flag('region') ?? env('BADGERIQ_TENANT_REGION') ?? 'us';
  const plan = flag('plan') ?? env('BADGERIQ_TENANT_PLAN') ?? 'trial';

  if (!name || !adminEmail) {
    process.stderr.write(
      'usage: provision-tenant --name <name> --admin-email <email> [--region us] [--plan trial|team|enterprise]\n',
    );
    process.exit(2);
  }
  if (!EMAIL_RE.test(adminEmail)) {
    process.stderr.write(`invalid --admin-email '${adminEmail}'\n`);
    process.exit(2);
  }
  if (!(PLANS as readonly string[]).includes(plan)) {
    process.stderr.write(`invalid --plan '${plan}' (must be one of ${PLANS.join('|')})\n`);
    process.exit(2);
  }

  const tenantId = randomUUID();
  // Plaintext key: `alk_` + 48 hex chars (24 random bytes). Only its SHA-256 hash is stored.
  const virtualKey = `alk_${randomBytes(24).toString('hex')}`;
  const keyHash = sha256hex(virtualKey);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);

  const result = await prisma.withTenant(tenantId, async (tx) => {
    // Step 1 — tenant (explicit tenantId satisfies the tenants WITH CHECK under our context).
    await tx.tenant.create({ data: { tenantId, name, region, plan } });

    // Step 2a — default team.
    const team = await tx.team.create({ data: { tenantId, name: 'Default' } });

    // Step 2b — first admin identity.
    const identity = await tx.identity.create({
      data: {
        tenantId,
        email: adminEmail,
        source: 'manual',
        apiRole: 'admin',
        active: true,
        teamId: team.teamId,
      },
    });

    // Step 2c — first virtual key (hash only; plaintext is returned to stdout, never stored).
    const vk = await tx.virtualKey.create({
      data: { tenantId, name: 'Default key', keyHash, environment: 'production' },
    });

    // Step 2d — audit the provisioning. detail carries steps only, never the key plaintext.
    await tx.auditLog.create({
      data: {
        tenantId,
        actor: 'system:provision-tenant',
        action: 'create',
        object: `tenant:${tenantId}`,
        detail: { steps: ['tenant', 'team', 'identity', 'virtual_key'] },
      },
    });

    return { teamId: team.teamId, userId: identity.userId, keyId: vk.keyId };
  });

  await app.close();

  process.stdout.write(
    `${JSON.stringify({
      event: 'tenant.provisioned',
      tenant_id: tenantId,
      tenant_name: name,
      team_id: result.teamId,
      admin_user_id: result.userId,
      admin_email: adminEmail,
      virtual_key_id: result.keyId,
      virtual_key: virtualKey, // plaintext shown ONCE — never logged again (rule 6)
      at: new Date().toISOString(),
    })}\n`,
  );
}

void main();

import { PostgresAnalyticsStore } from './postgres-analytics.store';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-context';

describe('PostgresAnalyticsStore RLS binding', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';

  function harness() {
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ tenant_id: tenantA, n: 1 }]),
      $executeRawUnsafe: jest.fn(async () => 1),
    };
    const withTenant = jest.fn(async (_t: string | null, fn: (t: typeof tx) => unknown) => fn(tx));
    const prisma = {
      withTenant,
      $queryRawUnsafe: jest.fn(async () => [{ n: 1 }]),
      $executeRawUnsafe: jest.fn(async () => 1),
      $queryRaw: jest.fn(async () => [
        { column_name: 'tenant_id', udt_name: 'text' },
        { column_name: 'call_id', udt_name: 'text' },
        { column_name: 'ts', udt_name: 'timestamptz' },
      ]),
    } as unknown as PrismaService;
    const store = new PostgresAnalyticsStore(prisma);
    return { store, prisma, withTenant, tx };
  }

  it('query binds app.tenant_id from ALS when params omit tenant', async () => {
    const { store, withTenant, prisma } = harness();
    await runWithTenant({ tenantId: tenantA, userId: null, role: 'admin' }, async () => {
      await store.query('SELECT 1 AS n FROM llm_calls WHERE 1=1', {});
    });
    expect(withTenant).toHaveBeenCalledWith(tenantA, expect.any(Function));
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('query stays unscoped when no tenant param and no ALS (health-style)', async () => {
    const { store, withTenant, prisma } = harness();
    await store.query('SELECT 1 AS n', {});
    expect(withTenant).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('queryScoped always withTenant + principal tenant', async () => {
    const { store, withTenant } = harness();
    await runWithTenant({ tenantId: tenantA, userId: null, role: 'admin' }, async () => {
      await store.queryScoped(
        'SELECT cost_usd FROM llm_calls WHERE tenant_id = {tenant:String}',
        {},
      );
    });
    expect(withTenant).toHaveBeenCalledWith(tenantA, expect.any(Function));
  });

  it('insertRows refuses when tenant_id and ALS are both absent', async () => {
    const { store } = harness();
    await expect(
      store.insertRows('llm_calls', [{ call_id: 'c1', ts: '2026-01-01T00:00:00Z' }]),
    ).rejects.toThrow(/refuse insert without tenant_id/);
  });

  it('insertRows binds ALS tenant when row tenant_id is present', async () => {
    const { store, withTenant, tx } = harness();
    await runWithTenant({ tenantId: tenantA, userId: null, role: 'admin' }, async () => {
      await store.insertRows('llm_calls', [
        { call_id: 'c1', ts: '2026-01-01T00:00:00Z', tenant_id: tenantA },
      ]);
    });
    expect(withTenant).toHaveBeenCalledWith(tenantA, expect.any(Function));
    expect(tx.$executeRawUnsafe).toHaveBeenCalled();
  });
});

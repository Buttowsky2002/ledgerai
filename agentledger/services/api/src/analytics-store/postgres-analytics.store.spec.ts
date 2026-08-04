import { insertBatchSize, PostgresAnalyticsStore } from './postgres-analytics.store';
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

  it('insertRows chunks so bind variables stay under the Postgres 32767 limit', async () => {
    const { store, tx, prisma } = harness();
    // 3 typed columns → batch size floor(30000/3)=10000; 10001 rows → 2 executes.
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { column_name: 'tenant_id', udt_name: 'text' },
      { column_name: 'call_id', udt_name: 'text' },
      { column_name: 'ts', udt_name: 'timestamptz' },
    ]);
    const rows = Array.from({ length: 10_001 }, (_, i) => ({
      tenant_id: tenantA,
      call_id: `c${i}`,
      ts: '2026-01-01T00:00:00Z',
    }));
    await runWithTenant({ tenantId: tenantA, userId: null, role: 'admin' }, async () => {
      await store.insertRows('llm_calls', rows);
    });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    for (const call of tx.$executeRawUnsafe.mock.calls) {
      // sql + bind values; values length must stay under the protocol cap
      expect(call.length - 1).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('insertBatchSize', () => {
  it('keeps cols*batch under the bind cap', () => {
    expect(insertBatchSize(15) * 15).toBeLessThanOrEqual(30_000);
    expect(insertBatchSize(1)).toBe(30_000);
    expect(insertBatchSize(0)).toBe(1);
  });
});

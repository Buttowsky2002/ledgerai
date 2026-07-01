import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { FixedCostsService } from './fixed-costs.service';

const principal: Principal = { tenantId: 'tenant-1', userId: 'u1', role: 'admin' };

function harness() {
  const insertRows = jest.fn<Promise<void>, [string, Record<string, unknown>[]]>(async () => undefined);
  const queryScoped = jest.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>(
    async () => [],
  );
  const command = jest.fn<Promise<void>, [string, Record<string, unknown>?]>(async () => undefined);
  const auditCreate = jest.fn<Promise<object>, [{ data: Record<string, unknown> }]>(async () => ({}));
  const tx = { auditLog: { create: auditCreate } };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const ch = { insertRows, queryScoped, command, query: jest.fn(async () => []) } as unknown as ClickHouseService;
  return { svc: new FixedCostsService(ch, prisma), insertRows, queryScoped, command, auditCreate };
}

describe('FixedCostsService.create', () => {
  it('stamps tenant from principal and forces attributable=0', async () => {
    const { svc, insertRows } = harness();
    await runWithTenant(principal, () =>
      svc.create({
        periodMonth: '2026-06-01',
        vendor: 'openai',
        costType: 'subscription',
        costUsd: 500,
        lineItem: 'ChatGPT Team',
      }),
    );
    expect(insertRows).toHaveBeenCalledTimes(1);
    const [table, rows] = insertRows.mock.calls[0];
    expect(table).toBe('fixed_costs');
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-1',
      period_month: '2026-06-01',
      vendor: 'openai',
      cost_type: 'subscription',
      cost_usd: 500,
      attributable: 0,
      source: 'manual',
    });
  });
});

describe('FixedCostsService.list', () => {
  it('does not alias period_month as String (ClickHouse ORDER BY type clash)', async () => {
    const { svc, queryScoped } = harness();
    await runWithTenant(principal, () => svc.list({ from: '2026-01-01', to: '2026-06-30' }));
    const [sql] = queryScoped.mock.calls[0];
    expect(sql).not.toMatch(/toString\(period_month\)\s+AS\s+period_month/i);
    expect(sql).toContain('ORDER BY period_month DESC');
  });
});

describe('FixedCostsService.remove', () => {
  it('issues tenant-scoped ALTER DELETE', async () => {
    const { svc, command } = harness();
    await runWithTenant(principal, () =>
      svc.remove({
        periodMonth: '2026-06-01',
        vendor: 'anthropic',
        costType: 'seat_license',
        lineItem: 'Claude Team',
      }),
    );
    expect(command).toHaveBeenCalledTimes(1);
    const [sql, params] = command.mock.calls[0];
    expect(sql).toContain('ALTER TABLE agentledger.fixed_costs DELETE');
    expect(params).toMatchObject({ tenant: 'tenant-1', vendor: 'anthropic' });
  });
});

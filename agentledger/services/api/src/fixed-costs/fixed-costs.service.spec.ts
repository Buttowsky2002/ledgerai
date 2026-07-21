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

  it('filters by start-of-month overlap so mid-month ranges include the month', async () => {
    const { svc, queryScoped } = harness();
    await runWithTenant(principal, () => svc.list({ from: '2026-06-15', to: '2026-07-07' }));
    const [sql, params] = queryScoped.mock.calls[0];
    expect(sql).toContain('toStartOfMonth(toDate({from:String}))');
    expect(sql).toContain('toStartOfMonth(toDate({to:String}))');
    expect(params).toMatchObject({ from: '2026-06-15', to: '2026-07-07' });
  });
});

describe('FixedCostsService.totalCostOfAi', () => {
  it('uses month-start bounds on v_total_cost_of_ai.month', async () => {
    const { svc, queryScoped } = harness();
    await runWithTenant(principal, () => svc.totalCostOfAi('2026-06-15', '2026-07-07'));
    expect(queryScoped).toHaveBeenCalledTimes(2);
    const [sql] = queryScoped.mock.calls[0];
    expect(sql).toContain('v_total_cost_of_ai');
    expect(sql).toContain('toStartOfMonth(toDate({from:String}))');
  });

  it('prorates fixed overhead to the selected date range', async () => {
    const { svc, queryScoped } = harness();
    queryScoped
      .mockResolvedValueOnce([
        { month: '2026-06-01', attributable_cost_usd: 0, fixed_cost_usd: 2730 },
      ])
      .mockResolvedValueOnce([
        { period_month: '2026-06-01', cost_usd: 1380 },
        { period_month: '2026-06-01', cost_usd: 1350 },
      ]);
    const rows = await runWithTenant(principal, () => svc.totalCostOfAi('2026-06-09', '2026-06-10'));
    expect(rows[0]?.fixed_cost_usd).toBe(182);
    expect(rows[0]?.monthly_fixed_cost_usd).toBe(2730);
  });
});

describe('FixedCostsService.monthlySummary', () => {
  it('returns prorated cost_usd and monthly_cost_usd', async () => {
    const { svc, queryScoped } = harness();
    queryScoped.mockResolvedValueOnce([
      {
        period_month: '2026-06-01',
        vendor: 'anthropic',
        cost_type: 'seat_license',
        cost_usd: 1380,
        seats: 46,
        last_imported_at: '2026-06-01',
      },
    ]);
    const rows = await runWithTenant(principal, () => svc.monthlySummary('2026-06-09', '2026-06-10'));
    expect(rows[0]).toMatchObject({
      monthly_cost_usd: 1380,
      cost_usd: 92,
    });
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

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PrismaService } from '../prisma/prisma.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { OutcomesService } from './outcomes.service';

const principal: Principal = { tenantId: 'tenant-1', userId: 'u1', role: 'analyst' };

function harness() {
  const insertRows = jest.fn<Promise<void>, [string, Record<string, unknown>[]]>(async () => undefined);
  const queryScoped = jest.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>(
    async () => [],
  );
  const auditCreate = jest.fn<Promise<object>, [{ data: Record<string, unknown> }]>(async () => ({}));
  const tx = { auditLog: { create: auditCreate } };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const ch = { insertRows, queryScoped } as unknown as ClickHouseService;
  return { svc: new OutcomesService(ch, prisma), insertRows, queryScoped, auditCreate };
}

describe('OutcomesService.create', () => {
  it('maps the DTO to a canonical outcomes row, stamps tenant from the principal, and audits', async () => {
    const { svc, insertRows, auditCreate } = harness();
    const res = await runWithTenant(principal, () =>
      svc.create({
        outcomeType: 'pr_merged',
        valueUsd: 1500,
        runId: 'run_7',
        teamId: 'eng',
        confidence: 0.9,
        // a malicious tenant_id in the body must be ignored
        ...({ tenant_id: 'ATTACKER' } as object),
      }),
    );

    expect(insertRows).toHaveBeenCalledTimes(1);
    const [table, rows] = insertRows.mock.calls[0];
    expect(table).toBe('outcomes');
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-1',
      outcome_type: 'pr_merged',
      business_value_usd: 1500,
      run_id: 'run_7',
      team_id: 'eng',
      attribution_confidence: 0.9,
      source_system: 'api',
      completion_status: 'completed',
    });
    expect(String(rows[0].outcome_id)).toMatch(/^out_[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain('ATTACKER');
    expect(res.outcome_id).toBe(rows[0].outcome_id);
    expect(res.value_usd).toBe(1500);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: 'create',
      object: `outcome:${res.outcome_id}`,
      actor: 'u1',
    });
  });

  it('applies defaults: source=api, confidence=1, status=completed, ts=now', async () => {
    const { svc, insertRows } = harness();
    await runWithTenant(principal, () => svc.create({ outcomeType: 'lead', valueUsd: 0 }));
    const row = insertRows.mock.calls[0][1][0];
    expect(row).toMatchObject({
      source_system: 'api',
      attribution_confidence: 1,
      completion_status: 'completed',
      run_id: '',
      business_value_usd: 0,
    });
    expect(typeof row.ts).toBe('string');
  });

  it('writes ClickHouse before the audit (so a write failure is never silently audited)', async () => {
    const { svc, insertRows, auditCreate } = harness();
    await runWithTenant(principal, () => svc.create({ outcomeType: 'lead', valueUsd: 1 }));
    expect(insertRows.mock.invocationCallOrder[0]).toBeLessThan(auditCreate.mock.invocationCallOrder[0]);
  });

  it('throws when there is no tenant in context', async () => {
    const { svc } = harness();
    await expect(svc.create({ outcomeType: 'lead', valueUsd: 1 })).rejects.toThrow(/no tenant/i);
  });
});

describe('OutcomesService.list', () => {
  it('scopes by tenant filter and binds optional filters as parameters', async () => {
    const { svc, queryScoped } = harness();
    await runWithTenant(principal, () =>
      svc.list({ outcomeType: 'pr_merged', agentId: 'a1', minConfidence: 0.5 }),
    );
    const [sql, params] = queryScoped.mock.calls[0];
    expect(sql).toMatch(/tenant_id = \{tenant:String\}/);
    expect(sql).toContain('o.outcome_type = {otype:String}');
    expect(sql).toContain('r.agent_id = {agent:String}');
    expect(params).toMatchObject({ otype: 'pr_merged', agent: 'a1', minconf: 0.5 });
    // the agent's run cost rides along for the cost->outcome row
    expect(sql).toContain('r.total_cost_usd AS cost_usd');
  });

  it('defaults minConfidence to 0 (includes unattributed outcomes)', async () => {
    const { svc, queryScoped } = harness();
    await runWithTenant(principal, () => svc.list({}));
    expect(queryScoped.mock.calls[0][1]).toMatchObject({ minconf: 0 });
  });
});

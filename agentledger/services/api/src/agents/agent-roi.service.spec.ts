import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { AgentRoiService } from './agent-roi.service';

const principal: Principal = { tenantId: 'tenant-1', userId: 'u1', role: 'viewer' };

function harness(summary: Record<string, unknown>, daily: Record<string, unknown>[]) {
  const queryScoped = jest.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>(
    async (sql: string) => (/v_agent_daily_unit_economics/.test(sql) ? daily : [summary]),
  );
  const ch = { queryScoped } as unknown as ClickHouseService;
  return { svc: new AgentRoiService(ch), queryScoped };
}

describe('AgentRoiService.agentRoi', () => {
  it('scopes both queries to the tenant + agent and shapes the summary (coercing string scalars)', async () => {
    const { svc, queryScoped } = harness(
      {
        cost_usd: '12.5',
        value_usd: '1500',
        net_value_usd: '1480',
        outcomes_count: '3',
        cost_per_success: '4.1',
        attribution_confidence_avg: '0.9',
        risk_adjusted_roi: '1350',
      },
      [{ day: '2026-06-01', cost_usd: 12.5, value_usd: 1500 }],
    );

    const res = await runWithTenant(principal, () => svc.agentRoi('agent-9', '2026-06-01', '2026-06-30'));

    expect(res.agentId).toBe('agent-9');
    expect(res.summary).toEqual({
      cost_usd: 12.5,
      value_usd: 1500,
      net_value_usd: 1480,
      outcomes_count: 3,
      cost_per_success: 4.1,
      attribution_confidence_avg: 0.9,
      risk_adjusted_roi: 1350,
    });
    expect(res.daily).toHaveLength(1);

    for (const [sql, params] of queryScoped.mock.calls) {
      expect(sql).toMatch(/tenant_id = \{tenant:String\}/);
      expect(sql).toContain('agent_id = {agent:String}');
      expect(params).toMatchObject({ agent: 'agent-9', from: '2026-06-01', to: '2026-06-30' });
    }
  });

  it('returns cost_per_success = null when no successful outcomes (ClickHouse NULL)', async () => {
    const { svc } = harness(
      { cost_usd: 5, value_usd: 0, net_value_usd: -5, outcomes_count: 1, cost_per_success: null, attribution_confidence_avg: 0.2, risk_adjusted_roi: -5 },
      [],
    );
    const res = await runWithTenant(principal, () => svc.agentRoi('agent-1'));
    expect(res.summary.cost_per_success).toBeNull();
  });

  it('rejects an empty agent id', async () => {
    const { svc } = harness({}, []);
    await expect(runWithTenant(principal, () => svc.agentRoi(''))).rejects.toThrow(/agent id required/i);
  });
});

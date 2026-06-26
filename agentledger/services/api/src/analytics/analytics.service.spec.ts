import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { LariService } from '../lari/lari.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

/** Build an AnalyticsService with mocked ClickHouse + LARI. */
function harness(agentIds: string[]) {
  const queryScoped = jest.fn(async () => agentIds.map((id) => ({ agent_id: id })));
  const computeForAgent = jest.fn(async (agentId: string) => ({
    // only the fields agentEconomics reads
    fullyLoadedCostUsd: 10,
    attributedIncrementalValueUsd: 100,
    // risk_adjusted_roi (= netValueUsd) derived from the id so we can assert sorting
    netValueUsd: Number(agentId.replace(/\D/g, '')) || 0,
    lari: 2,
    confidenceScore: 80,
    recommendation: 'scale',
  }));
  const ch = { queryScoped } as unknown as ClickHouseService;
  const lari = { computeForAgent } as unknown as LariService;
  const prisma = {} as unknown as PrismaService;
  return { svc: new AnalyticsService(ch, prisma, lari), computeForAgent };
}

describe('AnalyticsService.agentEconomics', () => {
  it('runs LARI per agent and sorts by risk-adjusted ROI descending', async () => {
    const { svc, computeForAgent } = harness(['agent-3', 'agent-1', 'agent-9']);
    const rows = await svc.agentEconomics('2026-06-01', '2026-06-30');
    expect(computeForAgent).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => r.agentId)).toEqual(['agent-9', 'agent-3', 'agent-1']); // 9 > 3 > 1
    expect(rows[0]).toMatchObject({
      cost_usd: 10,
      value_usd: 100,
      risk_adjusted_roi: 9,
      confidenceScore: 80,
      recommendation: 'scale',
    });
  });

  it('caps the fan-out at 25 agents (no silent unbounded LARI runs)', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `agent-${i}`);
    const { svc, computeForAgent } = harness(ids);
    const rows = await svc.agentEconomics();
    expect(rows).toHaveLength(25);
    expect(computeForAgent).toHaveBeenCalledTimes(25);
  });
});

describe('AnalyticsService.sourceReconciliation', () => {
  it('aggregates portal vs API spend by day', async () => {
    const queryScoped = jest.fn(async () => [
      {
        day: '2026-03-01',
        portal_cost_usd: 12.5,
        portal_calls: 2,
        api_cost_usd: 0,
        api_calls: 0,
      },
      {
        day: '2026-04-01',
        portal_cost_usd: 0,
        portal_calls: 0,
        api_cost_usd: 8,
        api_calls: 1,
      },
      {
        day: '2026-04-02',
        portal_cost_usd: 5,
        portal_calls: 1,
        api_cost_usd: 5,
        api_calls: 1,
      },
    ]);
    const ch = { queryScoped } as unknown as ClickHouseService;
    const svc = new AnalyticsService(ch, {} as PrismaService, {} as LariService);
    const result = await svc.sourceReconciliation('2026-03-01', '2026-04-30');
    expect(result.summary.portalTotalUsd).toBeCloseTo(17.5);
    expect(result.summary.apiTotalUsd).toBeCloseTo(13);
    expect(result.summary.overlapDays).toBe(1);
    expect(result.summary.portalOnlyDays).toBe(1);
    expect(result.summary.apiOnlyDays).toBe(1);
    expect(result.days).toHaveLength(3);
  });
});

import { BadRequestException } from '@nestjs/common';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { LariService } from '../lari/lari.service';
import { PrismaService } from '../prisma/prisma.service';
import { Principal, runWithTenant } from '../tenant/tenant-context';
import { DesignPartnerOnboardingService } from './design-partner.service';
import type { DesignPartnerProfile } from './design-partner.types';

const TENANT = '00000000-0000-4000-8000-000000000001';
const principal: Principal = { tenantId: TENANT, userId: 'u1', role: 'admin' };

const STUDIO_PROFILE: DesignPartnerProfile = {
  presentation: { from: '2026-04-01', to: '2026-06-30' },
  agents: [{ name: 'CodeReviewAgent', runtimeType: 'claude_code', approvalStatus: 'approved' }],
  runs: [
    {
      runId: 'bootstrap_run_1',
      agentId: 'CodeReviewAgent',
      startedAt: '2026-06-08T14:00:00.000Z',
      endedAt: '2026-06-08T14:12:00.000Z',
      status: 'completed',
      totalCostUsd: 18.5,
      totalTokens: 4200,
      llmCalls: 6,
      toolCalls: 1,
      riskEvents: 0,
    },
  ],
  outcomes: [
    {
      outcomeId: 'bootstrap:github:studio/pr-101',
      ts: '2026-06-08T14:15:00.000Z',
      sourceSystem: 'github',
      outcomeType: 'pr_merged',
      businessValueUsd: 420,
      completionStatus: 'merged',
    },
  ],
  roiRates: [],
};

function harness(opts: {
  existingAgent?: boolean;
  stampedCount?: number;
  vRoiCount?: number;
  edgeCount?: number;
} = {}) {
  const agentFindFirst = jest.fn(async () => (opts.existingAgent ? { agentId: 'a1' } : null));
  const agentCreate = jest.fn(async () => ({ agentId: 'new' }));
  const executeRaw = jest.fn(async () => 0);
  const auditCreate = jest.fn(async () => ({}));
  const edgeQuery = jest.fn(async () => [{ cnt: BigInt(opts.edgeCount ?? 1) }]);

  const tx = {
    agent: { findFirst: agentFindFirst, create: agentCreate },
    $executeRaw: executeRaw,
    $queryRaw: edgeQuery,
    auditLog: { create: auditCreate },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  const queryScoped = jest.fn(async (sql: string) => {
    if (sql.includes('countIf(run_id')) {
      return [{ cnt: opts.stampedCount ?? 1 }];
    }
    if (sql.includes('v_roi')) {
      return [{ cnt: opts.vRoiCount ?? 1 }];
    }
    return [];
  });
  const command = jest.fn(async () => undefined);
  const insertRows = jest.fn(async () => undefined);
  const ch = { queryScoped, command, insertRows } as unknown as ClickHouseService;

  const lariResult = {
    agentId: 'CodeReviewAgent',
    lari: 2.5,
    netValueUsd: 400,
    fullyLoadedCostUsd: 50,
    confidenceScore: 72,
    recommendation: 'scale' as const,
    breakdown: { cost: {}, risk: {}, confidence: {} },
    period: { from: '2026-04-01', to: '2026-06-30' },
    attributedIncrementalValueUsd: 420,
    expectedRiskLossUsd: 0,
    uncertaintyReserveUsd: 10,
    ledger: {
      valueDrivers: [],
      costDrivers: [],
      riskDrivers: [],
      confidenceFactors: [],
      attributionReasons: [],
      baselineMethod: '',
      limitations: [],
    },
  };
  const lari = {
    computeForAgent: jest.fn(async () => lariResult),
  } as unknown as LariService;

  const svc = new DesignPartnerOnboardingService(prisma, ch, lari);
  (svc as unknown as { presets: Map<string, DesignPartnerProfile> }).presets = new Map([
    ['studio-live', STUDIO_PROFILE],
  ]);

  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true })) as unknown as typeof fetch;

  return {
    svc,
    agentCreate,
    insertRows,
    command,
    auditCreate,
    lari,
    restoreFetch: () => {
      global.fetch = originalFetch;
    },
  };
}

const run = (svc: DesignPartnerOnboardingService, dto: Parameters<DesignPartnerOnboardingService['onboard']>[0]) =>
  runWithTenant(principal, () => svc.onboard(dto));

describe('DesignPartnerOnboardingService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('onboards from preset: registers agent, seeds CH, returns LARI report', async () => {
    const { svc, agentCreate, insertRows, auditCreate, lari, restoreFetch } = harness();
    try {
      const report = await run(svc, { preset: 'studio-live' });

      expect(report.preset).toBe('studio-live');
      expect(report.agentsRegistered).toBe(1);
      expect(report.runsSeeded).toBe(1);
      expect(report.outcomesSeeded).toBe(1);
      expect(report.ready).toBe(true);
      expect(report.lari).toHaveLength(1);
      expect(report.lari[0].lari).toBe(2.5);
      expect(agentCreate).toHaveBeenCalledTimes(1);
      expect(insertRows).toHaveBeenCalledWith('agent_runs', expect.any(Array));
      expect(insertRows).toHaveBeenCalledWith('outcomes', expect.any(Array));
      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(lari.computeForAgent).toHaveBeenCalledWith(
        'CodeReviewAgent',
        '2026-04-01',
        '2026-06-30',
      );
    } finally {
      restoreFetch();
    }
  });

  it('skips agent create when name already exists', async () => {
    const { svc, agentCreate, restoreFetch } = harness({ existingAgent: true });
    try {
      const report = await run(svc, { preset: 'studio-live' });
      expect(report.agentsRegistered).toBe(0);
      expect(agentCreate).not.toHaveBeenCalled();
    } finally {
      restoreFetch();
    }
  });

  it('rejects unknown preset', async () => {
    const { svc, restoreFetch } = harness();
    try {
      await expect(run(svc, { preset: 'missing' })).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      restoreFetch();
    }
  });

  it('rejects custom runs without bootstrap prefix', async () => {
    const { svc, restoreFetch } = harness();
    try {
      await expect(
        run(svc, {
          agents: [{ name: 'A' }],
          runs: [
            {
              runId: 'bad_run',
              agentId: 'A',
              startedAt: '2026-01-01T00:00:00.000Z',
              endedAt: '2026-01-01T00:01:00.000Z',
              status: 'completed',
              totalCostUsd: 1,
              totalTokens: 1,
              llmCalls: 1,
              toolCalls: 0,
              riskEvents: 0,
            },
          ],
          outcomes: [
            {
              outcomeId: 'bootstrap:test:1',
              ts: '2026-01-01T00:02:00.000Z',
              sourceSystem: 'manual',
              outcomeType: 'test',
              businessValueUsd: 10,
              completionStatus: 'done',
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      restoreFetch();
    }
  });
});

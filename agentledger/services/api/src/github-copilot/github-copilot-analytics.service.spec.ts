import { PrismaService } from '../prisma/prisma.service';
import { CopilotAnalyticsService } from './github-copilot-analytics.service';

describe('CopilotAnalyticsService', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const connectionId = 'c8e9d7fd-43dd-4b04-8797-1b814f0b28c7';

  function harness(overrides: {
    connections?: { connectionId: string; roiAssumptions: object }[];
    usage?: object[];
    roi?: object[];
    seats?: object[];
    memberSpend?: object[];
  }) {
    const withTenant = jest.fn(async (_tid: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        aiProviderConnection: {
          findMany: jest.fn(async () => overrides.connections ?? []),
        },
        githubCopilotUsageDaily: {
          findMany: jest.fn(async () => overrides.usage ?? []),
        },
        githubCopilotRoiDaily: {
          findMany: jest.fn(async () => overrides.roi ?? []),
        },
        githubCopilotSeat: {
          findMany: jest.fn(async () => overrides.seats ?? []),
        },
        githubCopilotMemberSpendDaily: {
          findMany: jest.fn(async () => overrides.memberSpend ?? []),
        },
      };
      return fn(tx);
    });
    const prisma = { withTenant } as unknown as PrismaService;
    return new CopilotAnalyticsService(prisma);
  }

  it('returns null when no Copilot connections exist', async () => {
    const svc = harness({});
    expect(await svc.getSpendSummary(tenantId, '2026-06-01', '2026-06-03')).toBeNull();
  });

  it('prorates seat cost daily and sums overage without double-counting monthly base', async () => {
    const svc = harness({
      connections: [{ connectionId, roiAssumptions: {} }],
      seats: [{ isActive: true }],
      roi: [
        {
          usageDate: new Date('2026-06-01T00:00:00.000Z'),
          baseSeatCost: 361,
          overageEstimate: 5,
          estimatedValue: 100,
        },
        {
          usageDate: new Date('2026-06-02T00:00:00.000Z'),
          baseSeatCost: 361,
          overageEstimate: 2,
          estimatedValue: 50,
        },
      ],
      usage: [
        {
          model: 'gpt-4o',
          feature: '',
          linesAccepted: 10,
          chatTurns: 2,
          acceptancesCount: 5,
          prSummaryCount: 1,
        },
      ],
    });
    const summary = await svc.getSpendSummary(tenantId, '2026-06-01', '2026-06-02');
    expect(summary).not.toBeNull();
    // 361/30 ≈ 12.03 per day × 2 days + overage 5 + 2
    expect(summary!.totalCostUsd).toBeCloseTo(12.03 * 2 + 7, 1);
    expect(summary!.estimatedValueUsd).toBe(150);
    expect(summary!.platform.platform).toBe('GitHub Copilot');
    expect(summary!.modelMix[0]?.provider).toBe('github_copilot');
  });

  it('uses persisted member spend rows when available so org total matches member sum', async () => {
    const svc = harness({
      connections: [{ connectionId, roiAssumptions: {} }],
      memberSpend: [
        {
          usageDate: new Date('2026-06-01T00:00:00.000Z'),
          totalAllocatedCost: 150,
          estimatedValueCreated: 40,
        },
        {
          usageDate: new Date('2026-06-01T00:00:00.000Z'),
          totalAllocatedCost: 176,
          estimatedValueCreated: 60,
        },
        {
          usageDate: new Date('2026-06-02T00:00:00.000Z'),
          totalAllocatedCost: 200,
          estimatedValueCreated: 80,
        },
      ],
      usage: [],
    });
    const summary = await svc.getSpendSummary(tenantId, '2026-06-01', '2026-06-02');
    expect(summary!.totalCostUsd).toBe(526);
    expect(summary!.estimatedValueUsd).toBe(180);
  });
});

import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { CopilotAnalyticsService } from '../github-copilot/github-copilot-analytics.service';
import { CopilotMemberSpendService } from '../github-copilot/github-copilot-member-spend.service';
import { LariService } from '../lari/lari.service';
import { PrismaService } from '../prisma/prisma.service';
import { loadIdentityLookups } from '../reports/identity-resolver';
import { AnalyticsService } from './analytics.service';

jest.mock('../tenant/tenant-context', () => ({
  getTenantId: () => 'tenant-test',
  getPrincipal: () => ({ userId: 'test-user' }),
}));

jest.mock('../reports/identity-resolver', () => {
  const actual = jest.requireActual('../reports/identity-resolver');
  return {
    ...actual,
    loadIdentityLookups: jest.fn(),
  };
});

const mockedLoadIdentityLookups = loadIdentityLookups as jest.MockedFunction<typeof loadIdentityLookups>;

function emptyCopilotMemberSpend(): CopilotMemberSpendService {
  return {
    getMemberSpend: jest.fn(async () => ({ connected: false, members: [] })),
  } as unknown as CopilotMemberSpendService;
}

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
  const copilotAnalytics = {
    getSpendSummary: jest.fn(async () => null),
  } as unknown as CopilotAnalyticsService;
  return { svc: new AnalyticsService(ch, prisma, lari, copilotAnalytics, emptyCopilotMemberSpend()), computeForAgent };
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
    const svc = new AnalyticsService(ch, {} as PrismaService, {} as LariService, {
      getSpendSummary: jest.fn(async () => null),
    } as unknown as CopilotAnalyticsService, emptyCopilotMemberSpend());
    const result = await svc.sourceReconciliation('2026-03-01', '2026-04-30');
    expect(result.summary.portalTotalUsd).toBeCloseTo(17.5);
    expect(result.summary.apiTotalUsd).toBeCloseTo(13);
    expect(result.summary.overlapDays).toBe(1);
    expect(result.summary.portalOnlyDays).toBe(1);
    expect(result.summary.apiOnlyDays).toBe(1);
    expect(result.days).toHaveLength(3);
  });
});

describe('AnalyticsService.users', () => {
  const uuidAlice = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    mockedLoadIdentityLookups.mockResolvedValue({
      byId: new Map([[uuidAlice, { displayName: 'Alice Smith', email: 'alice@acme.test', teamName: 'Eng' }]]),
      byEmail: new Map([['dev@company.com', { displayName: 'Dev User', email: 'dev@company.com', teamName: 'Eng' }]]),
      byAlias: new Map([['cursor-user-99', { displayName: 'Cursor Dev', email: null, teamName: 'Eng' }]]),
    });
  });

  function usersHarness() {
    const queryScoped = jest.fn(async (sql: string, params?: Record<string, unknown>) => {
      if (params?.userId === 'missing-user') return [];
      if (sql.includes('GROUP BY user_id, provider, model')) {
        return [
          {
            user_id: uuidAlice,
            platform: 'openai',
            model: 'gpt-4o',
            spend_usd: 30,
            calls: 10,
          },
          {
            user_id: uuidAlice,
            platform: 'anthropic',
            model: 'claude-3-5-sonnet',
            spend_usd: 20,
            calls: 5,
          },
          {
            user_id: 'cursor-user-99',
            platform: 'openai',
            model: 'gpt-4o-mini',
            spend_usd: 8,
            calls: 2,
          },
          {
            user_id: 'orphan-handle',
            platform: 'openai',
            model: 'gpt-4o-mini',
            spend_usd: 4,
            calls: 1,
          },
        ];
      }
      return [
        { user_id: uuidAlice, total_spend_usd: 50, calls: 15 },
        { user_id: 'cursor-user-99', total_spend_usd: 8, calls: 2 },
        { user_id: 'orphan-handle', total_spend_usd: 4, calls: 1 },
        { user_id: 'zero-spend', total_spend_usd: 0, calls: 0 },
      ];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const svc = new AnalyticsService(ch, {} as PrismaService, {} as LariService, {
      getSpendSummary: jest.fn(async () => null),
    } as unknown as CopilotAnalyticsService, emptyCopilotMemberSpend());
    return { svc, queryScoped };
  }

  it('merges totals with model breakdown and resolves identities', async () => {
    const { svc } = usersHarness();
    const result = await svc.users('2026-06-01', '2026-06-30');
    expect(result.users.map((u) => u.user_id)).toEqual([uuidAlice, 'cursor-user-99', 'orphan-handle']);
    const alice = result.users[0];
    expect(alice).toMatchObject({
      display_name: 'Alice Smith',
      email: 'alice@acme.test',
      team: 'Eng',
      resolved: true,
      total_spend_usd: 50,
      calls: 15,
      models: ['gpt-4o', 'claude-3-5-sonnet'],
    });
    expect(alice.model_breakdown).toHaveLength(2);
    expect(result.users.find((u) => u.user_id === 'cursor-user-99')).toMatchObject({
      display_name: 'Cursor Dev',
      resolved: true,
    });
    const orphan = result.users.find((u) => u.user_id === 'orphan-handle');
    expect(orphan).toMatchObject({
      display_name: 'orphan-handle',
      resolved: false,
      email: null,
    });
    expect(result.users.some((u) => u.user_id === 'zero-spend')).toBe(false);
  });

  it('merges spend rows that resolve to the same email identity', async () => {
    const queryScoped = jest.fn(async (sql: string, params?: Record<string, unknown>) => {
      if (params?.userId) return [];
      if (sql.includes('GROUP BY user_id, provider, model')) {
        return [
          { user_id: 'demo-user-0', platform: 'openai', model: 'gpt-4o', spend_usd: 10, calls: 2 },
          { user_id: 'alice.chen@acme.test', platform: 'openai', model: 'gpt-4o', spend_usd: 5, calls: 1 },
        ];
      }
      return [
        { user_id: 'demo-user-0', total_spend_usd: 10, calls: 2 },
        { user_id: 'alice.chen@acme.test', total_spend_usd: 5, calls: 1 },
      ];
    });
    mockedLoadIdentityLookups.mockResolvedValueOnce({
      byId: new Map(),
      byEmail: new Map([
        ['alice.chen@acme.test', { displayName: 'Alice Chen', email: 'alice.chen@acme.test', teamName: 'Eng' }],
      ]),
      byAlias: new Map([
        ['demo-user-0', { displayName: 'Alice Chen', email: 'alice.chen@acme.test', teamName: 'Eng' }],
      ]),
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const svc = new AnalyticsService(ch, {} as PrismaService, {} as LariService, {
      getSpendSummary: jest.fn(async () => null),
    } as unknown as CopilotAnalyticsService, emptyCopilotMemberSpend());
    const result = await svc.users('2026-06-01', '2026-06-30');
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({
      display_name: 'Alice Chen',
      email: 'alice.chen@acme.test',
      total_spend_usd: 15,
      calls: 3,
      resolved: true,
    });
  });

  it('filters by q on display name, email, and team', async () => {
    const { svc } = usersHarness();
    const byName = await svc.users('2026-06-01', '2026-06-30', 'alice');
    expect(byName.users).toHaveLength(1);
    expect(byName.users[0].display_name).toBe('Alice Smith');

    mockedLoadIdentityLookups.mockResolvedValueOnce({
      byId: new Map(),
      byEmail: new Map([['dev@company.com', { displayName: 'Dev User', email: 'dev@company.com', teamName: 'Platform' }]]),
      byAlias: new Map([['cursor-user-99', { displayName: 'Cursor Dev', email: 'dev@company.com', teamName: 'Platform' }]]),
    });
    const byEmail = await svc.users('2026-06-01', '2026-06-30', 'dev@company');
    expect(byEmail.users.some((u) => u.user_id === 'cursor-user-99')).toBe(true);

    const byTeam = await svc.users('2026-06-01', '2026-06-30', 'eng');
    expect(byTeam.users.every((u) => u.team.toLowerCase().includes('eng') || u.display_name.toLowerCase().includes('eng'))).toBe(true);
  });

  it('merges GitHub Copilot members with token spend users', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('GROUP BY user_id, provider, model')) return [];
      return [{ user_id: 'cursor-user-99', total_spend_usd: 8, calls: 2 }];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const getMemberSpend = jest.fn(async () => ({
      connected: true,
      members: [
        {
          githubLogin: 'octocat',
          displayName: 'Octocat',
          teamName: 'Platform',
          totalAllocatedCost: 19,
          chatTurns: 3,
          linesAccepted: 2,
          prSummaryCount: 0,
        },
      ],
    }));
    const svc = new AnalyticsService(
      ch,
      {} as PrismaService,
      {} as LariService,
      { getSpendSummary: jest.fn(async () => null) } as unknown as CopilotAnalyticsService,
      { getMemberSpend } as unknown as CopilotMemberSpendService,
    );

    const result = await svc.users('2026-06-01', '2026-06-30');
    expect(result.sources).toEqual({ llm_call_users: 1, copilot_members: 1 });
    expect(result.users).toHaveLength(2);
    const copilot = result.users.find((u) => u.user_id === 'octocat');
    expect(copilot).toMatchObject({
      display_name: 'Octocat',
      team: 'Platform',
      resolved: false,
      total_spend_usd: 19,
      models: ['Copilot'],
    });
  });

  it('returns a single user from userDetail', async () => {
    const { svc } = usersHarness();
    const row = await svc.userDetail(uuidAlice, '2026-06-01', '2026-06-30');
    expect(row?.user_id).toBe(uuidAlice);
    expect(row?.model_breakdown).toHaveLength(2);
    expect(await svc.userDetail('missing-user', '2026-06-01', '2026-06-30')).toBeNull();
  });
});

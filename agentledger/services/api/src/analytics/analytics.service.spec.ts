import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { CopilotAnalyticsService } from '../github-copilot/github-copilot-analytics.service';
import { CopilotMemberSpendService } from '../github-copilot/github-copilot-member-spend.service';
import { LariService } from '../lari/lari.service';
import { PrismaService } from '../prisma/prisma.service';
import { loadIdentityLookups } from '../reports/identity-resolver';
import { CursorAnalyticsService } from '../connectors/cursor-analytics.service';
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

function emptyCursorAnalytics() {
  return {
    getSpendSummary: jest.fn(async () => null),
    getDailyBilledSpend: jest.fn(async () => []),
    getUserBilledSpend: jest.fn(async () => []),
    getUserBilledBreakdown: jest.fn(async () => []),
    getUserDailyBilledSpend: jest.fn(async () => []),
  };
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
  return { svc: new AnalyticsService(ch, prisma, lari, copilotAnalytics, emptyCopilotMemberSpend(), emptyCursorAnalytics() as never), computeForAgent };
}

describe('AnalyticsService.meteredSpend', () => {
  it('merges Copilot daily spend from Postgres into llm_calls metered totals', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('toDate(ts) AS day')) {
        return [
          { day: '2026-07-01', cost_usd: 100, calls: 10, tokens: 1000, blocked_calls: 0, error_calls: 0 },
          { day: '2026-07-02', cost_usd: 50, calls: 5, tokens: 500, blocked_calls: 0, error_calls: 0 },
        ];
      }
      return [];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const copilotAnalytics = {
      getSpendSummary: jest.fn(async () => ({
        totalCostUsd: 30,
        daily: [{ day: '2026-07-01', cost_usd: 30 }],
        platform: { platform: 'GitHub Copilot', cost_usd: 30, calls: 3 },
        modelMix: [],
        estimatedValueUsd: 0,
        totalCalls: 3,
      })),
    } as unknown as CopilotAnalyticsService;
    const cursorAnalytics = {
      getSpendSummary: jest.fn(async () => null),
      getDailyBilledSpend: jest.fn(async () => [
        { day: '2026-07-02', cost_usd: 208.51, calls: 115 },
      ]),
    };
    const svc = new AnalyticsService(
      ch,
      {} as PrismaService,
      {} as LariService,
      copilotAnalytics,
      emptyCopilotMemberSpend(),
      cursorAnalytics as never,
    );

    const rows = await svc.spend('2026-07-01', '2026-07-02');
    expect(queryScoped).toHaveBeenCalled();
    expect(rows).toEqual([
      expect.objectContaining({ day: '2026-07-01', cost_usd: 130 }),
      expect.objectContaining({ day: '2026-07-02', cost_usd: 50, calls: 5 }),
    ]);
  });

  it('uses metered cost for platform spend across all connectors', async () => {
    const queryScoped = jest.fn(async () => [
      { platform: 'openai', cost_usd: 100, calls: 10 },
      { platform: 'cursor', cost_usd: 208.51, calls: 115 },
    ]);
    const ch = { queryScoped } as unknown as ClickHouseService;
    const cursorAnalytics = {
      getSpendSummary: jest.fn(async () => null),
      getDailyBilledSpend: jest.fn(async () => []),
      getUserBilledSpend: jest.fn(async () => []),
      getUserBilledBreakdown: jest.fn(async () => []),
      getUserDailyBilledSpend: jest.fn(async () => []),
    };
    const svc = new AnalyticsService(
      ch,
      {} as PrismaService,
      {} as LariService,
      { getSpendSummary: jest.fn(async () => null) } as unknown as CopilotAnalyticsService,
      emptyCopilotMemberSpend(),
      cursorAnalytics as never,
    );

    const rows = await svc.platformSpend('2026-07-01', '2026-07-06');
    expect(queryScoped).toHaveBeenCalled();
    expect(rows).toEqual(
      expect.arrayContaining([
        { platform: 'openai', cost_usd: 100, calls: 10 },
        { platform: 'cursor', cost_usd: 208.51, calls: 115 },
      ]),
    );
  });
});

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
    } as unknown as CopilotAnalyticsService, emptyCopilotMemberSpend(), emptyCursorAnalytics() as never);
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
      if (sql.includes('user_id, platform, model, spend_usd')) {
        return [
          {
            user_id: uuidAlice,
            platform: 'openai',
            model: 'gpt-4o',
            spend_usd: 30,
            calls: 10,
            portal_import_usd: 0,
            connector_usd: 30,
          },
          {
            user_id: uuidAlice,
            platform: 'anthropic',
            model: 'claude-3-5-sonnet',
            spend_usd: 20,
            calls: 5,
            portal_import_usd: 20,
            connector_usd: 0,
          },
          {
            user_id: 'cursor-user-99',
            platform: 'openai',
            model: 'gpt-4o-mini',
            spend_usd: 8,
            calls: 2,
            portal_import_usd: 0,
            connector_usd: 8,
          },
          {
            user_id: 'orphan-handle',
            platform: 'openai',
            model: 'gpt-4o-mini',
            spend_usd: 4,
            calls: 1,
            portal_import_usd: 0,
            connector_usd: 4,
          },
        ];
      }
      if (sql.includes('key, cost_usd, calls, portal_import_usd')) {
        return [
          { key: uuidAlice, cost_usd: 50, calls: 15, portal_import_usd: 20, connector_usd: 30 },
          { key: 'cursor-user-99', cost_usd: 8, calls: 2, portal_import_usd: 0, connector_usd: 8 },
          { key: 'orphan-handle', cost_usd: 4, calls: 1, portal_import_usd: 0, connector_usd: 4 },
          { key: 'zero-spend', cost_usd: 0, calls: 0, portal_import_usd: 0, connector_usd: 0 },
        ];
      }
      return [];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const svc = new AnalyticsService(ch, {} as PrismaService, {} as LariService, {
      getSpendSummary: jest.fn(async () => null),
    } as unknown as CopilotAnalyticsService, emptyCopilotMemberSpend(), emptyCursorAnalytics() as never);
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
      if (sql.includes('user_id, platform, model, spend_usd')) {
        return [
          { user_id: 'demo-user-0', platform: 'openai', model: 'gpt-4o', spend_usd: 10, calls: 2, portal_import_usd: 0, connector_usd: 10 },
          { user_id: 'alice.chen@acme.test', platform: 'openai', model: 'gpt-4o', spend_usd: 5, calls: 1, portal_import_usd: 0, connector_usd: 5 },
        ];
      }
      return [
        { key: 'demo-user-0', cost_usd: 10, calls: 2, portal_import_usd: 0, connector_usd: 10 },
        { key: 'alice.chen@acme.test', cost_usd: 5, calls: 1, portal_import_usd: 0, connector_usd: 5 },
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
    } as unknown as CopilotAnalyticsService, emptyCopilotMemberSpend(), emptyCursorAnalytics() as never);
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
      if (sql.includes('user_id, platform, model, spend_usd')) return [];
      if (sql.includes('key, cost_usd, calls, portal_import_usd')) {
        return [{ key: 'cursor-user-99', cost_usd: 8, calls: 2, portal_import_usd: 0, connector_usd: 8 }];
      }
      return [];
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
      emptyCursorAnalytics() as never,
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

  it('merges Cursor billed overage into user spend via metered llm_calls query', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('user_id, platform, model, spend_usd')) {
        return [
          { user_id: 'dev@company.com', platform: 'openai', model: 'gpt-4o', spend_usd: 10, calls: 2, portal_import_usd: 0, connector_usd: 10 },
          { user_id: 'brandon@example.com', platform: 'cursor', model: 'claude-opus', spend_usd: 170.12, calls: 90, portal_import_usd: 0, connector_usd: 170.12 },
        ];
      }
      if (sql.includes('key, cost_usd, calls, portal_import_usd')) {
        return [
          { key: 'dev@company.com', cost_usd: 10, calls: 2, portal_import_usd: 0, connector_usd: 10 },
          { key: 'brandon@example.com', cost_usd: 170.12, calls: 90, portal_import_usd: 0, connector_usd: 170.12 },
        ];
      }
      return [];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const svc = new AnalyticsService(
      ch,
      {} as PrismaService,
      {} as LariService,
      { getSpendSummary: jest.fn(async () => null) } as unknown as CopilotAnalyticsService,
      emptyCopilotMemberSpend(),
      emptyCursorAnalytics() as never,
    );

    const result = await svc.users('2026-07-01', '2026-07-06');
    const cursorUser = result.users.find((u) => u.user_id === 'brandon@example.com');
    expect(cursorUser?.total_spend_usd).toBe(170.12);
    expect(cursorUser?.model_breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'cursor', spend_usd: 170.12 }),
      ]),
    );
  });
});

describe('AnalyticsService.cursorSpend', () => {
  const cursorSummary = {
    billedUsd: 170.12,
    usageValueUsd: 50,
    totalCalls: 90,
    includedCalls: 10,
    onDemandCalls: 80,
    legacyUntagged: false,
    disclaimer: 'test',
    modelMix: [],
  };

  it('computes seat license from fixed costs × active members', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('count(DISTINCT user_id)')) return [{ members: 11 }];
      if (sql.includes('agentledger.fixed_costs')) {
        return [{ period_month: '2026-06-01', cost_usd: 600, seats: 15, unit_cost_usd: 40 }];
      }
      return [];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const cursorAnalytics = {
      getSpendSummary: jest.fn(async () => cursorSummary),
    } as unknown as CursorAnalyticsService;
    const svc = new AnalyticsService(
      ch,
      { withTenant: jest.fn() } as unknown as PrismaService,
      {} as LariService,
      { getSpendSummary: jest.fn(async () => null) } as unknown as CopilotAnalyticsService,
      emptyCopilotMemberSpend(),
      cursorAnalytics,
    );

    const result = await svc.cursorSpend('2026-06-01', '2026-06-30');
    expect(result?.activeMembersInRange).toBe(11);
    expect(result?.seatSource).toBe('fixed_costs');
    expect(result?.seatUnitUsdPerMonth).toBe(40);
    expect(result?.seatCount).toBe(11);
    expect(result?.seatLicenseUsd).toBe(440);
  });

  it('still returns active members when seat license query fails', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('count(DISTINCT user_id)')) return [{ members: 11 }];
      if (sql.includes('agentledger.fixed_costs')) throw new Error('ILLEGAL_AGGREGATION');
      return [];
    });
    const ch = { queryScoped } as unknown as ClickHouseService;
    const cursorAnalytics = {
      getSpendSummary: jest.fn(async () => cursorSummary),
    } as unknown as CursorAnalyticsService;
    const svc = new AnalyticsService(
      ch,
      { withTenant: jest.fn() } as unknown as PrismaService,
      {} as LariService,
      { getSpendSummary: jest.fn(async () => null) } as unknown as CopilotAnalyticsService,
      emptyCopilotMemberSpend(),
      cursorAnalytics,
    );

    const result = await svc.cursorSpend('2026-06-01', '2026-06-30');
    expect(result?.activeMembersInRange).toBe(11);
    expect(result?.seatSource).toBe('none');
    expect(result?.seatLicenseUsd).toBe(0);
  });
});

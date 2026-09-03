import { LariRecommendationsService } from './lari-recommendations.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { PrismaService } from '../prisma/prisma.service';
import { LariService } from './lari.service';
import { UserValueService } from '../analytics/user-value.service';

jest.mock('../tenant/tenant-context', () => ({
  getTenantId: () => 'tenant-1',
}));

describe('LariRecommendationsService', () => {
  const queryScoped = jest.fn(async (sql: string) => {
    if (sql.includes('platform AS provider')) {
      return [{ provider: 'openai', cost_usd: 100, calls: 50 }];
    }
    if (sql.includes('FROM (') && sql.includes('reconciled') && sql.includes('day')) {
      return [{ day: '2026-06-01', cost_usd: 10 }];
    }
    if (sql.includes("key = 'Unassigned'")) {
      return [{ unmapped_cost: 0 }];
    }
    if (sql.includes('v_agent_daily_unit_economics')) {
      return [];
    }
    if (sql.includes('agent_id, provider')) {
      return [];
    }
    if (sql.includes('reconciled_input_tokens')) {
      return [];
    }
    if (sql.includes('priceBook')) {
      return [];
    }
    return [];
  });

  const ch = { queryScoped } as unknown as AnalyticsStore;
  const prisma = {
    priceBook: { findMany: jest.fn(async () => []) },
    withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: jest.fn(async () => [{ purchased: 0, active: 0 }]),
        aiProviderConnection: { findMany: jest.fn(async () => []) },
        tenant: {
          findUnique: jest.fn(async () => ({ complianceFlags: {} })),
        },
      }),
    ),
  } as unknown as PrismaService;

  const lari = { computeForAgent: jest.fn() } as unknown as LariService;
  const userValue = {
    assembleUserUtilization: jest.fn(async () => []),
  } as unknown as UserValueService;

  beforeEach(() => {
    queryScoped.mockClear();
  });

  it('queries reconciled metered spend instead of spend_daily MVs', async () => {
    const svc = new LariRecommendationsService(ch, prisma, lari, userValue);
    await svc.getRecommendations('2026-06-01', '2026-06-30');

    const sqls = queryScoped.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('platform AS provider'))).toBe(true);
    expect(
      sqls.some((s) => s.includes('sum((CASE WHEN portal_usd > 0 THEN portal_in ELSE api_in END)')),
    ).toBe(true);
    expect(sqls.some((s) => s.includes('metered_cost_usd'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM spend_daily'))).toBe(false);
    expect(sqls.some((s) => s.includes('spend_daily_by_user'))).toBe(false);
  });

  it('falls back to fixed-cost seat plans and active metered users when ai_seats are empty', async () => {
    queryScoped.mockImplementation(
      (async (sql: string) => {
        if (sql.includes('platform AS provider')) {
          return [{ provider: 'anthropic', cost_usd: 500, calls: 80 }];
        }
        if (sql.includes('countDistinct(if(user_id =')) {
          return [{ provider: 'anthropic', active_users: 4 }];
        }
        if (sql.includes('FROM agentledger.fixed_costs FINAL')) {
          return [
            {
              period_month: '2026-08-01',
              vendor: 'anthropic',
              cost_type: 'subscription',
              line_item: 'Claude Team',
              seats: 10,
              cost_usd: 250,
            },
          ];
        }
        return [];
      }) as never,
    );

    const emptyPrisma = {
      priceBook: { findMany: jest.fn(async () => []) },
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          $queryRaw: jest.fn(async () => []),
          aiProviderConnection: { findMany: jest.fn(async () => []) },
          tenant: {
            findUnique: jest.fn(async () => ({ complianceFlags: {} })),
          },
        }),
      ),
    } as unknown as PrismaService;
    const svc = new LariRecommendationsService(ch, emptyPrisma, lari, userValue);
    const input = await svc.assembleEngineInput('tenant-1', '2026-08-01', '2026-08-31');
    const plan = input.subscriptionPlans.find((p) => p.provider === 'anthropic');
    expect(plan).toBeDefined();
    expect(plan?.seatsPurchased).toBe(10);
    expect(plan?.activeSeats).toBe(4);
    expect(input.seatStats).toEqual({ purchased: 10, active: 4 });
  });
});

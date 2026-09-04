import { AnalyticsStore } from '../analytics-store/analytics-store';
import { PrismaService } from '../prisma/prisma.service';
import { UserValueService } from './user-value.service';

describe('UserValueService criticality', () => {
  it('uses the higher of person and subscription-plan criticality', async () => {
    const queryScoped = jest.fn(async () => []);
    const tx = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('');
        if (sql.includes('FROM ai_seats')) {
          return [
            {
              user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              email: 'alex@example.test',
              provider: 'cursor',
              plan_id: '11111111-2222-3333-4444-555555555555',
              plan_name: 'Cursor Team',
              monthly_price_per_user: 40,
              contract_monthly_cost: 400,
              seats_purchased: 10,
              criticality_tier: 'critical',
            },
          ];
        }
        return [];
      }),
      identity: {
        findMany: jest.fn(async () => [
          {
            userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            email: 'alex@example.test',
            displayName: 'Alex',
            teamId: null,
            aliases: [],
            criticalityTier: 'high',
          },
        ]),
      },
      team: { findMany: jest.fn(async () => []) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new UserValueService({ queryScoped } as unknown as AnalyticsStore, prisma);

    const rows = await service.assembleUserUtilization(
      'tenant-1',
      { from: '2026-07-01', to: '2026-07-30' },
      'team',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.criticalityTier).toBe('critical');
  });
});

describe('UserValueService portal activity', () => {
  it('counts $0 portal activity days toward activeDays and utilization', async () => {
    const queryScoped = jest.fn(async (sql: string) => {
      if (sql.includes('ORDER BY cost_usd DESC') && sql.includes('GROUP BY key')) {
        return [{ key: 'jane@co.com', cost_usd: 0, calls: 12 }];
      }
      if (sql.includes('AS user_id') && sql.includes('platform')) {
        return [{ user_id: 'jane@co.com', platform: 'anthropic', spend_usd: 0, calls: 12 }];
      }
      if (sql.includes('FROM coding_agent_daily')) {
        return [];
      }
      if (sql.includes('AS user_id, day')) {
        return [
          { user_id: 'jane@co.com', day: '2026-08-01', cost_usd: 0, calls: 4 },
          { user_id: 'jane@co.com', day: '2026-08-02', cost_usd: 0, calls: 8 },
        ];
      }
      return [];
    });
    const tx = {
      $queryRaw: jest.fn(async () => []),
      identity: { findMany: jest.fn(async () => []) },
      team: { findMany: jest.fn(async () => []) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new UserValueService({ queryScoped } as unknown as AnalyticsStore, prisma);

    const rows = await service.assembleUserUtilization(
      'tenant-1',
      { from: '2026-08-01', to: '2026-08-31' },
      'team',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls).toBe(12);
    expect(rows[0]!.costUsd).toBe(0);
    expect(rows[0]!.activeDays).toBe(2);
    expect(rows[0]!.status).not.toBe('inactive');
  });
});

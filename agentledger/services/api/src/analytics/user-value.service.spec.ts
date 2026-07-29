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

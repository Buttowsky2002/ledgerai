import {
  findUtilizationMatch,
  mergeDirectoryWithUtilization,
  utilizationIndex,
  type DirectoryUserLike,
} from './user-directory-utilization';
import type { UserUtilizationRow } from './user-value.types';

const util = (overrides: Partial<UserUtilizationRow> = {}): UserUtilizationRow => ({
  userId: 'jane@co.com',
  displayName: 'Jane',
  providers: ['anthropic'],
  costUsd: 0,
  calls: 0,
  activeDays: 0,
  codingAgentCostUsd: 0,
  sessions: 0,
  utilizationScore: 0,
  seatMonthlyCostUsd: 40,
  status: 'inactive',
  hasSeat: true,
  planName: 'Claude Team',
  seatProvider: 'anthropic',
  ...overrides,
});

const dir = (overrides: Partial<DirectoryUserLike>): DirectoryUserLike => ({
  user_id: 'jane@co.com',
  display_name: 'Jane',
  email: 'jane@co.com',
  team: 'Eng',
  resolved: true,
  total_spend_usd: 12,
  calls: 3,
  models: [],
  model_breakdown: [],
  ...overrides,
});

describe('mergeDirectoryWithUtilization', () => {
  it('attaches status to matching directory users', () => {
    const merged = mergeDirectoryWithUtilization(
      [dir({})],
      [util({ status: 'active', calls: 3, costUsd: 12, utilizationScore: 55 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('active');
    expect(merged[0]!.has_seat).toBe(true);
  });

  it('appends inactive seat holders missing from spend directory', () => {
    const merged = mergeDirectoryWithUtilization(
      [
        dir({
          user_id: 'active@co.com',
          display_name: 'Active',
          email: 'active@co.com',
          team: '',
          total_spend_usd: 5,
          calls: 2,
        }),
      ],
      [
        util({ userId: 'active@co.com', displayName: 'Active', status: 'active', calls: 2 }),
        util({ userId: 'idle@co.com', displayName: 'Idle', status: 'inactive', calls: 0 }),
      ],
    );
    expect(merged.map((u) => u.user_id)).toEqual(['active@co.com', 'idle@co.com']);
    expect(merged[1]!.status).toBe('inactive');
    expect(merged[1]!.has_seat).toBe(true);
  });

  it('indexes by email for lookup', () => {
    const byKey = utilizationIndex([util()]);
    expect(
      findUtilizationMatch({ user_id: 'x', email: 'jane@co.com', display_name: 'J' }, byKey),
    ).toBeTruthy();
  });
});

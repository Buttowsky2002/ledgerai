import { canonicalUserKey, collapseDirectoryRowsByDisplayName } from './user-directory.util';
import type { UserDirectoryRow } from './analytics.service';

const row = (
  partial: Partial<UserDirectoryRow> & Pick<UserDirectoryRow, 'user_id'>,
): UserDirectoryRow => ({
  display_name: partial.display_name ?? 'Russ McClelland',
  email: partial.email ?? null,
  team: partial.team ?? 'Eng',
  resolved: partial.resolved ?? false,
  total_spend_usd: partial.total_spend_usd ?? 0,
  calls: partial.calls ?? 0,
  models: partial.models ?? [],
  model_breakdown: partial.model_breakdown ?? [],
  ...partial,
});

describe('canonicalUserKey', () => {
  it('collapses resolved identities by display name', () => {
    expect(
      canonicalUserKey('a', {
        display_name: 'Russ McClelland',
        email: 'russ@studiodesigner.com',
        team: 'Eng',
        teamId: null,
        criticalityTier: 'standard',
        resolved: true,
        active: true,
      }),
    ).toBe('name:russ mcclelland');
    expect(
      canonicalUserKey('b', {
        display_name: 'Russ-McClelland',
        email: 'russ@gmail.com',
        team: 'Eng',
        teamId: null,
        criticalityTier: 'standard',
        resolved: true,
        active: true,
      }),
    ).toBe('name:russ mcclelland');
  });
});

describe('collapseDirectoryRowsByDisplayName', () => {
  it('aggregates spend and keeps preferred studio email', () => {
    const collapsed = collapseDirectoryRowsByDisplayName([
      row({
        user_id: '1',
        email: 'russ@gmail.com',
        display_name: 'Russ McClelland',
        resolved: true,
        total_spend_usd: 10,
        calls: 2,
      }),
      row({
        user_id: '2',
        email: 'russ@studiodesigner.com',
        display_name: 'Russ McClelland',
        resolved: true,
        total_spend_usd: 5,
        calls: 1,
      }),
      row({
        user_id: 'russ-mcclelland',
        email: null,
        display_name: 'Russ-McClelland',
        resolved: false,
        total_spend_usd: 19,
        calls: 3,
      }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      email: 'russ@studiodesigner.com',
      display_name: 'Russ McClelland',
      total_spend_usd: 34,
      calls: 6,
      resolved: true,
    });
  });
});

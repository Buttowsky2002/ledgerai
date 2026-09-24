import { buildTeamSpendBreakdown } from './lari-cfo-view.util';

describe('buildTeamSpendBreakdown', () => {
  it('rolls user spend into SCIM teams and seeds empty provisioned teams', () => {
    const rows = buildTeamSpendBreakdown(
      [
        { userId: 'alice@acme.test', costUsd: 80, calls: 10 },
        { userId: 'bob@acme.test', costUsd: 20, calls: 4 },
        { userId: 'orphan-handle', costUsd: 10, calls: 1 },
      ],
      (userId) => {
        if (userId.startsWith('alice') || userId.startsWith('bob')) {
          return { teamId: 'team-eng', teamName: 'Engineering' };
        }
        return { teamId: null, teamName: '' };
      },
      [
        { teamId: 'team-eng', teamName: 'Engineering' },
        { teamId: 'team-finance', teamName: 'Finance' },
      ],
    );

    expect(rows).toEqual([
      {
        teamId: 'team-eng',
        teamName: 'Engineering',
        costUsd: 100,
        calls: 14,
        users: 2,
        sharePct: 90.91,
      },
      {
        teamId: null,
        teamName: 'Unassigned',
        costUsd: 10,
        calls: 1,
        users: 1,
        sharePct: 9.09,
      },
      {
        teamId: 'team-finance',
        teamName: 'Finance',
        costUsd: 0,
        calls: 0,
        users: 0,
        sharePct: 0,
      },
    ]);
  });

  it('returns only seeded teams when there is no spend', () => {
    const rows = buildTeamSpendBreakdown([], () => ({ teamId: null, teamName: '' }), [
      { teamId: 'team-a', teamName: 'Alpha' },
    ]);
    expect(rows).toEqual([
      {
        teamId: 'team-a',
        teamName: 'Alpha',
        costUsd: 0,
        calls: 0,
        users: 0,
        sharePct: 0,
      },
    ]);
  });

  it('includes allocated non-Cursor seats in department totals', () => {
    const rows = buildTeamSpendBreakdown(
      [
        { userId: 'alice@acme.test', costUsd: 40, calls: 2 },
        { userId: 'bob@acme.test', costUsd: 40, calls: 0 },
      ],
      () => ({ teamId: 'team-eng', teamName: 'Engineering' }),
      [{ teamId: 'team-eng', teamName: 'Engineering' }],
    );
    expect(rows[0]).toMatchObject({
      teamId: 'team-eng',
      costUsd: 80,
      users: 2,
    });
  });
});

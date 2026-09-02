import {
  buildMemberSpendAggregates,
  buildRoiDayTeamAggregates,
  buildTeamSeatCounts,
} from './github-copilot-sync.util';

describe('buildRoiDayTeamAggregates', () => {
  it('sums usage rows by day and team, coercing Decimal credits and maxing user counts', () => {
    const day = new Date('2026-06-01T00:00:00.000Z');
    const result = buildRoiDayTeamAggregates(
      [
        {
          usageDate: day,
          teamSlug: 'eng',
          linesAccepted: 10,
          chatTurns: 2,
          prSummaryCount: 1,
          aiCreditsUsed: 30,
          activeUsers: 3,
          engagedUsers: 2,
        },
        {
          usageDate: day,
          teamSlug: 'eng',
          linesAccepted: 5,
          chatTurns: 1,
          prSummaryCount: 0,
          aiCreditsUsed: 20,
          activeUsers: 1,
          engagedUsers: 4,
        },
      ],
      0,
    );
    const agg = result.get('2026-06-01|eng');
    expect(agg).toBeDefined();
    expect(agg?.linesAccepted).toBe(15);
    expect(agg?.aiCreditsUsed).toBe(50);
    expect(agg?.activeUsers).toBe(3);
    expect(agg?.engagedUsers).toBe(4);
  });

  it('seeds a single empty today bucket when there is no usage but seats exist', () => {
    const result = buildRoiDayTeamAggregates([], 5);
    expect(result.size).toBe(1);
    const [key] = [...result.keys()];
    expect(key.endsWith('|')).toBe(true);
  });

  it('stays empty when there is no usage and no seats', () => {
    expect(buildRoiDayTeamAggregates([], 0).size).toBe(0);
  });
});

describe('buildTeamSeatCounts', () => {
  const nowMs = Date.parse('2026-06-30T00:00:00.000Z');

  it('counts assigned seats and marks active only within a 28-day activity window', () => {
    const result = buildTeamSeatCounts(
      [
        {
          assigningTeamSlug: 'eng',
          isActive: true,
          lastActivityAt: new Date('2026-06-20T00:00:00.000Z'),
        },
        {
          assigningTeamSlug: 'eng',
          isActive: true,
          lastActivityAt: new Date('2026-05-01T00:00:00.000Z'),
        },
        {
          assigningTeamSlug: 'eng',
          isActive: false,
          lastActivityAt: new Date('2026-06-29T00:00:00.000Z'),
        },
      ],
      nowMs,
    );
    expect(result.get('eng')).toEqual({ assigned: 3, active: 1 });
  });

  it('buckets seats with no assigning team under the empty-string key', () => {
    const result = buildTeamSeatCounts(
      [{ assigningTeamSlug: null, isActive: true, lastActivityAt: null }],
      nowMs,
    );
    expect(result.get('')).toEqual({ assigned: 1, active: 0 });
  });
});

describe('buildMemberSpendAggregates', () => {
  it('builds seat, overage, and per-day member maps and backfills active seats', () => {
    const usageDate = new Date('2026-06-01T00:00:00.000Z');
    const { seatByLogin, overageByDay, byDay } = buildMemberSpendAggregates({
      seats: [
        {
          githubLogin: 'alice',
          monthlySeatCost: 19,
          lastActivityAt: usageDate,
          isActive: true,
          assigningTeamSlug: 'eng',
        },
        {
          githubLogin: 'bob',
          monthlySeatCost: 19,
          lastActivityAt: usageDate,
          isActive: true,
          assigningTeamSlug: 'eng',
        },
      ],
      usage: [
        {
          githubLogin: 'alice',
          usageDate,
          teamSlug: 'eng',
          aiCreditsUsed: 50,
          linesAccepted: 12,
          chatTurns: 3,
          prSummaryCount: 1,
        },
      ],
      roiRows: [{ usageDate, overageEstimate: 5, aiCreditsUsed: 50 }],
      memberTeams: [{ githubLogin: 'alice', teamSlug: 'eng' }],
    });

    expect(seatByLogin.get('alice')?.monthlySeatCost).toBe(19);
    expect(overageByDay.get('2026-06-01')?.totalOverageCost).toBe(5);

    const day = byDay.get('2026-06-01');
    expect(day).toBeDefined();
    // alice from usage + bob backfilled as an active seat with no usage row.
    expect(day?.length).toBe(2);
    const alice = day?.find((m) => m.githubLogin === 'alice');
    expect(alice?.aiCreditsUsed).toBe(50);
    expect(alice?.linesAccepted).toBe(12);
    const bob = day?.find((m) => m.githubLogin === 'bob');
    expect(bob?.aiCreditsUsed).toBe(0);
  });

  it('does not backfill inactive seats', () => {
    const usageDate = new Date('2026-06-01T00:00:00.000Z');
    const { byDay } = buildMemberSpendAggregates({
      seats: [
        {
          githubLogin: 'carol',
          monthlySeatCost: 19,
          lastActivityAt: null,
          isActive: false,
          assigningTeamSlug: 'eng',
        },
      ],
      usage: [
        {
          githubLogin: 'alice',
          usageDate,
          teamSlug: 'eng',
          aiCreditsUsed: 10,
          linesAccepted: 1,
          chatTurns: 0,
          prSummaryCount: 0,
        },
      ],
      roiRows: [],
      memberTeams: [],
    });
    const day = byDay.get('2026-06-01');
    expect(day?.some((m) => m.githubLogin === 'carol')).toBe(false);
  });
});

import {
  allocatedOverageCost,
  calculateMemberDailySpend,
  calculateMemberRoi,
  dailySeatCost,
  daysInMonth,
  estimatedCreditCost,
  isInactiveSeat,
  isLowUsageSeat,
  resolveUtilizationStatus,
} from './github-copilot-member-spend';
import { DEFAULT_ROI_ASSUMPTIONS } from './github-copilot.types';

const assumptions = DEFAULT_ROI_ASSUMPTIONS;
const now = new Date('2024-06-15T12:00:00.000Z');

describe('daysInMonth', () => {
  it('returns 30 for June 2024', () => {
    expect(daysInMonth('2024-06-01')).toBe(30);
  });

  it('returns 31 for January 2024', () => {
    expect(daysInMonth('2024-01-15')).toBe(31);
  });
});

describe('dailySeatCost', () => {
  it('prorates monthly seat cost by days in month', () => {
    expect(dailySeatCost(19, '2024-06-01')).toBeCloseTo(19 / 30, 4);
  });
});

describe('estimatedCreditCost', () => {
  it('multiplies credits by configured price', () => {
    expect(estimatedCreditCost(100, 0.01)).toBe(1);
    expect(estimatedCreditCost(0, 0.01)).toBe(0);
  });
});

describe('allocatedOverageCost', () => {
  it('allocates proportionally by credit share', () => {
    expect(allocatedOverageCost(500, 1000, 20)).toBe(10);
  });

  it('returns zero when org has no overage', () => {
    expect(allocatedOverageCost(500, 1000, 0)).toBe(0);
  });

  it('returns zero when user has no credits', () => {
    expect(allocatedOverageCost(0, 1000, 20)).toBe(0);
  });
});

describe('calculateMemberRoi', () => {
  it('computes ROI from usage and allocated cost', () => {
    const r = calculateMemberRoi({
      linesAccepted: 100,
      chatTurns: 10,
      prSummaryCount: 5,
      totalAllocatedCost: 19,
      assumptions,
    });
    expect(r.estimatedHoursSaved).toBeGreaterThan(0);
    expect(r.estimatedValueCreated).toBeGreaterThan(0);
    expect(r.roiPercentage).toBeGreaterThan(0);
  });

  it('returns null ROI when cost is zero', () => {
    const r = calculateMemberRoi({
      linesAccepted: 10,
      chatTurns: 0,
      prSummaryCount: 0,
      totalAllocatedCost: 0,
      assumptions,
    });
    expect(r.roiPercentage).toBeNull();
  });
});

describe('calculateMemberDailySpend', () => {
  it('combines seat, credit, and overage allocation', () => {
    const result = calculateMemberDailySpend({
      usage: {
        githubLogin: 'alice',
        teamSlug: 'eng',
        usageDate: '2024-06-01',
        aiCreditsUsed: 200,
        linesAccepted: 50,
        chatTurns: 5,
        prSummaryCount: 2,
      },
      seat: {
        githubLogin: 'alice',
        monthlySeatCost: 19,
        isActive: true,
        lastActivityAt: new Date('2024-06-14T00:00:00.000Z'),
      },
      orgOverage: {
        usageDate: '2024-06-01',
        totalOverageCost: 10,
        totalOrgAiCreditsUsed: 1000,
      },
      assumptions,
      peerUsage: [{ githubLogin: 'alice', score: 255 }],
      now,
    });
    expect(result.seatCost).toBeCloseTo(19 / 30, 2);
    expect(result.estimatedCreditCost).toBe(2);
    expect(result.allocatedOverageCost).toBe(2);
    expect(result.totalAllocatedCost).toBeCloseTo(result.seatCost + 2 + 2, 1);
  });
});

describe('inactive seat detection', () => {
  it('flags seat with no activity beyond threshold', () => {
    expect(
      isInactiveSeat(
        {
          githubLogin: 'bob',
          monthlySeatCost: 19,
          isActive: true,
          lastActivityAt: new Date('2024-04-01T00:00:00.000Z'),
        },
        0,
        30,
        now,
      ),
    ).toBe(true);
  });

  it('does not flag active users', () => {
    expect(
      isInactiveSeat(
        {
          githubLogin: 'carol',
          monthlySeatCost: 19,
          isActive: true,
          lastActivityAt: new Date('2024-06-10T00:00:00.000Z'),
        },
        50,
        30,
        now,
      ),
    ).toBe(false);
  });
});

describe('low usage detection', () => {
  it('flags minimal usage over threshold days', () => {
    expect(
      isLowUsageSeat(
        {
          githubLogin: 'dan',
          monthlySeatCost: 19,
          isActive: true,
          lastActivityAt: new Date('2024-05-20T00:00:00.000Z'),
        },
        2,
        14,
        now,
      ),
    ).toBe(true);
  });
});

describe('utilization status', () => {
  it('detects negative ROI', () => {
    const status = resolveUtilizationStatus({
      seat: {
        githubLogin: 'eve',
        monthlySeatCost: 19,
        isActive: true,
        lastActivityAt: new Date('2024-06-10T00:00:00.000Z'),
      },
      usageInPeriod: 10,
      roiPercentage: -50,
      score: 10,
      peerScores: [{ githubLogin: 'eve', score: 10 }],
      assumptions,
      now,
    });
    expect(status).toBe('negative_roi');
  });

  it('detects high ROI', () => {
    const status = resolveUtilizationStatus({
      seat: {
        githubLogin: 'frank',
        monthlySeatCost: 19,
        isActive: true,
        lastActivityAt: new Date('2024-06-10T00:00:00.000Z'),
      },
      usageInPeriod: 100,
      roiPercentage: 200,
      score: 100,
      peerScores: [{ githubLogin: 'frank', score: 100 }],
      assumptions,
      now,
    });
    expect(status).toBe('high_roi');
  });
});

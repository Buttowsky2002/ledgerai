import {
  aggregateBillingByUserDay,
  billingLookupKey,
  billingMonthKey,
  billingMonthsFromUserDay,
  calculateMemberDailySpendWithBilling,
  monthsInLookback,
} from './github-copilot-billing';
import { calculateMemberDailySpend, calculateMemberDailySpendSeatOnly } from './github-copilot-member-spend';
import { DEFAULT_ROI_ASSUMPTIONS } from './github-copilot.types';

const assumptions = DEFAULT_ROI_ASSUMPTIONS;
const now = new Date('2024-06-15T12:00:00.000Z');

describe('monthsInLookback', () => {
  it('includes each UTC month touched by the window', () => {
    const months = monthsInLookback(35, new Date('2024-06-15T12:00:00.000Z'));
    expect(months).toEqual(
      expect.arrayContaining([
        { year: 2024, month: 5 },
        { year: 2024, month: 6 },
      ]),
    );
  });
});

describe('aggregateBillingByUserDay', () => {
  it('sums gross and net amounts per user per day', () => {
    const map = aggregateBillingByUserDay([
      {
        usageDate: '2024-06-01',
        githubLogin: 'alice',
        product: 'copilot',
        sku: 'copilot_ai_credit',
        model: 'gpt-4o',
        unitType: 'ai-credits',
        grossQuantity: 100,
        grossAmount: 1,
        discountAmount: 0.5,
        netAmount: 0.5,
        rawPayload: {},
      },
      {
        usageDate: '2024-06-01',
        githubLogin: 'alice',
        product: 'copilot',
        sku: 'copilot_ai_credit',
        model: 'claude-3.5',
        unitType: 'ai-credits',
        grossQuantity: 50,
        grossAmount: 0.5,
        discountAmount: 0.25,
        netAmount: 0.25,
        rawPayload: {},
      },
    ]);
    const agg = map.get(billingLookupKey('2024-06-01', 'alice'));
    expect(agg?.grossQuantity).toBe(150);
    expect(agg?.grossAmount).toBe(1.5);
    expect(agg?.netAmount).toBe(0.75);
  });
});

describe('billingMonthKey', () => {
  it('groups by YYYY-MM and login', () => {
    expect(billingMonthKey('2024-06-15', 'Alice')).toBe('2024-06|alice');
  });
});

describe('billingMonthsFromUserDay', () => {
  it('collects user-month buckets from billing aggregates', () => {
    const map = aggregateBillingByUserDay([
      {
        usageDate: '2024-06-01',
        githubLogin: 'alice',
        product: 'copilot',
        sku: 'copilot_ai_credit',
        model: 'gpt-4o',
        unitType: 'ai-credits',
        grossQuantity: 10,
        grossAmount: 1,
        discountAmount: 0,
        netAmount: 1,
        rawPayload: {},
      },
    ]);
    const months = billingMonthsFromUserDay(map);
    expect(months.has('2024-06|alice')).toBe(true);
  });
});

describe('calculateMemberDailySpendWithBilling', () => {
  it('uses seat proration plus billed net amount instead of metrics estimate', () => {
    const result = calculateMemberDailySpendWithBilling(
      {
        usage: {
          githubLogin: 'alice',
          teamSlug: 'eng',
          usageDate: '2024-06-01',
          aiCreditsUsed: 9999,
          linesAccepted: 10,
          chatTurns: 2,
          prSummaryCount: 0,
        },
        seat: {
          githubLogin: 'alice',
          monthlySeatCost: 19,
          lastActivityAt: now,
          isActive: true,
          assigningTeamSlug: 'eng',
        },
        orgOverage: {
          usageDate: '2024-06-01',
          totalOverageCost: 100,
          totalOrgAiCreditsUsed: 5000,
        },
        assumptions,
        peerUsage: [{ githubLogin: 'alice', score: 1 }],
        now,
      },
      {
        githubLogin: 'alice',
        usageDate: '2024-06-01',
        grossQuantity: 2000,
        grossAmount: 20,
        discountAmount: 15,
        netAmount: 5,
      },
    );

    expect(result.allocatedOverageCost).toBe(5);
    expect(result.estimatedCreditCost).toBe(20);
    expect(result.aiCreditsUsed).toBe(2000);
    expect(result.totalAllocatedCost).toBe(5.63);
    expect(result.confidenceScore).toBe(0.98);
  });
});

describe('calculateMemberDailySpendSeatOnly', () => {
  it('charges seat proration only and skips estimated credits when month is billed', () => {
    const baseInput = {
      usage: {
        githubLogin: 'alice',
        teamSlug: 'eng',
        usageDate: '2024-06-15',
        aiCreditsUsed: 500,
        linesAccepted: 20,
        chatTurns: 5,
        prSummaryCount: 0,
      },
      seat: {
        githubLogin: 'alice',
        monthlySeatCost: 19,
        lastActivityAt: now,
        isActive: true,
        assigningTeamSlug: 'eng',
      },
      orgOverage: {
        usageDate: '2024-06-15',
        totalOverageCost: 100,
        totalOrgAiCreditsUsed: 5000,
      },
      assumptions,
      peerUsage: [{ githubLogin: 'alice', score: 1 }],
      now,
    };

    const estimate = calculateMemberDailySpend(baseInput);
    const seatOnly = calculateMemberDailySpendSeatOnly(baseInput);

    expect(seatOnly.totalAllocatedCost).toBeLessThan(estimate.totalAllocatedCost);
    expect(seatOnly.estimatedCreditCost).toBe(0);
    expect(seatOnly.allocatedOverageCost).toBe(0);
    expect(seatOnly.aiCreditsUsed).toBe(500);
  });

  it('month total equals seat proration plus one billing net when combined with billing day', () => {
    const seat = {
      githubLogin: 'alice',
      monthlySeatCost: 30,
      lastActivityAt: now,
      isActive: true,
      assigningTeamSlug: 'eng',
    };
    const usageDay1 = {
      githubLogin: 'alice',
      teamSlug: 'eng',
      usageDate: '2024-06-01',
      aiCreditsUsed: 100,
      linesAccepted: 0,
      chatTurns: 0,
      prSummaryCount: 0,
    };
    const usageDay2 = { ...usageDay1, usageDate: '2024-06-02', aiCreditsUsed: 200 };
    const base = {
      seat,
      orgOverage: undefined,
      assumptions,
      peerUsage: [],
      now,
    };

    const billed = calculateMemberDailySpendWithBilling(
      { ...base, usage: usageDay1 },
      {
        githubLogin: 'alice',
        usageDate: '2024-06-01',
        grossQuantity: 100,
        grossAmount: 10,
        discountAmount: 0,
        netAmount: 5,
      },
    );
    const day2 = calculateMemberDailySpendSeatOnly({ ...base, usage: usageDay2 });

    expect(billed.totalAllocatedCost + day2.totalAllocatedCost).toBeCloseTo(5 + 30 / 30 + 30 / 30, 2);
  });
});

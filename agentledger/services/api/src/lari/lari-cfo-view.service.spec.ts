import { calculateAttributedIncrementalValue, calculateFullyLoadedCost } from './lari';
import { CostBreakdown, OutcomeLink } from './lari.types';

describe('LariCfoViewService helpers', () => {
  it('fully-loaded cost sums all LARI cost components', () => {
    const cost: CostBreakdown = {
      tokenCostUsd: 100,
      humanReviewCostUsd: 20,
      infraCostUsd: 30,
      amortizedBuildCostUsd: 10,
    };
    expect(calculateFullyLoadedCost(cost)).toBe(160);
  });

  it('risk-adjusted value uses attribution confidence', () => {
    const outcomes: OutcomeLink[] = [
      {
        outcome: {
          outcomeId: 'o1',
          outcomeType: 'pr_merged',
          grossValueUsd: 1000,
          source: 'deterministic',
          verified: true,
          occurredAt: '2026-01-01',
        },
        attributionConfidence: 0.8,
        incrementalityFactor: 1,
        attributionMethod: 'deterministic',
        evidenceRefs: [],
      },
    ];
    expect(calculateAttributedIncrementalValue(outcomes)).toBe(800);
  });
});

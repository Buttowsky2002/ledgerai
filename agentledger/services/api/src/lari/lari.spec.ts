import { sampleAgentROIInput } from './lari.fixture';
import {
  calculateAttributedIncrementalValue,
  calculateExpectedRiskLoss,
  calculateFullyLoadedCost,
  calculateRiskAdjustedROI,
} from './lari';
import { AgentROIInput, OutcomeLink } from './lari.types';

/** Deep-clone the fixture and apply a mutation — keeps each test independent. */
function variant(mut: (i: AgentROIInput) => void): AgentROIInput {
  const i = structuredClone(sampleAgentROIInput);
  mut(i);
  return i;
}

const link = (over: Partial<OutcomeLink> & { grossValueUsd?: number; source?: OutcomeLink['outcome']['source'] }): OutcomeLink => ({
  outcome: {
    outcomeId: 'o1',
    outcomeType: 'invoice_processed',
    grossValueUsd: over.grossValueUsd ?? 1000,
    source: over.source ?? 'deterministic',
    verified: true,
    occurredAt: '2026-06-20',
  },
  attributionConfidence: over.attributionConfidence ?? 0.95,
  incrementalityFactor: over.incrementalityFactor ?? 0.8,
  attributionMethod: over.attributionMethod ?? 'deterministic',
  evidenceRefs: over.evidenceRefs ?? ['erp:invoice/1'],
});

describe('LARI — calculateRiskAdjustedROI recommendations', () => {
  it('positive, high-confidence ROI recommends scale', () => {
    const r = calculateRiskAdjustedROI(sampleAgentROIInput);
    expect(r.lari).toBeGreaterThan(0);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(r.recommendation).toBe('scale');
  });

  it('positive ROI but low confidence recommends improve_evidence', () => {
    const r = calculateRiskAdjustedROI(
      variant((i) => {
        i.confidence = {
          evidenceQuality: 0.3,
          attributionStrength: 0.3,
          causalStrength: 0.3,
          costCompleteness: 0.3,
          outcomeVerification: 0.3,
          recency: 0.3,
        };
      }),
    );
    expect(r.confidenceScore).toBeLessThan(50);
    expect(r.lari).toBeGreaterThan(0);
    expect(r.recommendation).toBe('improve_evidence');
  });

  it('negative ROI with real value recommends investigate', () => {
    const r = calculateRiskAdjustedROI(variant((i) => (i.cost.tokenCostUsd = 10000)));
    expect(r.lari).toBeLessThan(0);
    expect(r.attributedIncrementalValueUsd).toBeGreaterThan(1);
    expect(r.recommendation).toBe('investigate');
  });

  it('negative ROI with ~no value recommends retire', () => {
    const r = calculateRiskAdjustedROI(
      variant((i) => {
        i.outcomes = []; // produces nothing, but still costs money
      }),
    );
    expect(r.lari).toBeLessThan(0);
    expect(['investigate', 'retire']).toContain(r.recommendation);
    expect(r.recommendation).toBe('retire');
  });

  it('critical risk with positive ROI recommends require_approval', () => {
    const r = calculateRiskAdjustedROI(variant((i) => (i.risk.severity = 'critical')));
    expect(r.lari).toBeGreaterThanOrEqual(0);
    expect(r.recommendation).toBe('require_approval');
  });

  it('critical risk with negative ROI recommends pause', () => {
    const r = calculateRiskAdjustedROI(
      variant((i) => {
        i.risk.severity = 'critical';
        i.cost.tokenCostUsd = 10000;
      }),
    );
    expect(r.lari).toBeLessThan(0);
    expect(r.recommendation).toBe('pause');
  });
});

describe('LARI — calculation invariants', () => {
  it('zero cost does not divide by zero', () => {
    const r = calculateRiskAdjustedROI(
      variant((i) => {
        i.cost = { tokenCostUsd: 0, humanReviewCostUsd: 0, infraCostUsd: 0, amortizedBuildCostUsd: 0 };
      }),
    );
    expect(Number.isFinite(r.lari)).toBe(true);
    expect(Number.isNaN(r.lari)).toBe(false);
    expect(r.fullyLoadedCostUsd).toBe(0);
  });

  it('manual outcome value is discounted by low confidence', () => {
    const deterministic = calculateAttributedIncrementalValue([
      link({ grossValueUsd: 1000, source: 'deterministic', attributionConfidence: 0.95, incrementalityFactor: 0.9 }),
    ]);
    const manual = calculateAttributedIncrementalValue([
      link({ grossValueUsd: 1000, source: 'manual', attributionConfidence: 0.3, incrementalityFactor: 0.9 }),
    ]);
    expect(manual).toBeLessThan(deterministic);
    expect(manual).toBeCloseTo(1000 * 0.3 * 0.9, 6);
  });

  it('fully loaded cost includes human review and infra', () => {
    const cost = { tokenCostUsd: 2, humanReviewCostUsd: 40, infraCostUsd: 15, amortizedBuildCostUsd: 25 };
    expect(calculateFullyLoadedCost(cost)).toBe(82);
    // dropping human review + infra strictly lowers the loaded cost
    expect(calculateFullyLoadedCost({ ...cost, humanReviewCostUsd: 0, infraCostUsd: 0 })).toBe(27);
  });

  it('risk penalties reduce ROI', () => {
    const low = calculateRiskAdjustedROI(
      variant((i) => (i.risk = { severity: 'low', riskExposurePct: 0.05, incidentProbability: 0.1 })),
    );
    const high = calculateRiskAdjustedROI(
      variant((i) => (i.risk = { severity: 'high', riskExposurePct: 0.6, incidentProbability: 0.5 })),
    );
    expect(high.expectedRiskLossUsd).toBeGreaterThan(low.expectedRiskLossUsd);
    expect(high.lari).toBeLessThan(low.lari);
  });

  it('expected risk loss rises with exposure and probability', () => {
    const value = 1000;
    const a = calculateExpectedRiskLoss(value, { severity: 'low', riskExposurePct: 0.1, incidentProbability: 0.1 });
    const b = calculateExpectedRiskLoss(value, { severity: 'high', riskExposurePct: 0.5, incidentProbability: 0.5 });
    expect(a).toBeCloseTo(1000 * 0.1 * 0.1, 6);
    expect(b).toBeGreaterThan(a);
  });

  it('echoes an auditable evidence ledger with all driver sections', () => {
    const r = calculateRiskAdjustedROI(sampleAgentROIInput);
    expect(r.ledger.valueDrivers.length).toBeGreaterThan(0);
    expect(r.ledger.costDrivers.length).toBeGreaterThan(0);
    expect(r.ledger.riskDrivers.length).toBeGreaterThan(0);
    expect(r.ledger.confidenceFactors.length).toBeGreaterThan(0);
    expect(r.ledger.attributionReasons.length).toBeGreaterThan(0);
    expect(r.ledger.baselineMethod).toContain('counterfactual');
    expect(r.ledger.limitations.length).toBeGreaterThan(0);
  });
});

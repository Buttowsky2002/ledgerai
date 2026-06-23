import { AssembleInputs, buildAgentROIInput, EdgeRow, OutcomeMetaRow, VRoiOutcomeRow } from './lari.service';

const vroiRow = (over: Partial<VRoiOutcomeRow>): VRoiOutcomeRow => ({
  outcome_id: 'o1',
  outcome_type: 'invoice_processed',
  value_usd: 1000,
  qa_cost_usd: 10,
  eval_cost_usd: 2,
  integration_cost_usd: 3,
  platform_overhead_usd: 1,
  attribution_confidence: 0.9,
  risk_exposure_pct: 0.1,
  outcome_ts: '2026-06-20',
  ...over,
});

const base = (over: Partial<AssembleInputs> = {}): AssembleInputs => ({
  agentId: 'agent-1',
  from: '2026-06-01',
  to: '2026-06-30',
  vroi: [vroiRow({})],
  meta: new Map<string, OutcomeMetaRow>([['o1', { outcome_id: 'o1', source_system: 'erp', completion_status: 'completed' }]]),
  edges: new Map<string, EdgeRow>(),
  tokenCostUsd: 5,
  severity: 'low',
  riskEventCount: 0,
  ...over,
});

describe('buildAgentROIInput (LARI assembler)', () => {
  it('maps token cost from spend and human/infra from v_roi loaded components', () => {
    const input = buildAgentROIInput(base());
    expect(input.cost.tokenCostUsd).toBe(5); // from spend, not v_roi
    expect(input.cost.humanReviewCostUsd).toBe(10); // qa
    expect(input.cost.infraCostUsd).toBe(6); // eval+integration+platform
    expect(input.cost.amortizedBuildCostUsd).toBe(0);
  });

  it('uses the attribution edge counterfactual when present', () => {
    const input = buildAgentROIInput(
      base({
        edges: new Map([['o1', { outcomeId: 'o1', counterfactualDelta: 0.4, attributionMethod: 'shapley' }]]),
      }),
    );
    expect(input.outcomes[0].incrementalityFactor).toBe(0.4);
    expect(input.outcomes[0].attributionMethod).toBe('shapley');
    expect(input.baselineMethod).toContain('counterfactual delta from attribution edges');
  });

  it('defaults incrementality to full credit (1.0) when no baseline exists', () => {
    const input = buildAgentROIInput(base());
    expect(input.outcomes[0].incrementalityFactor).toBe(1.0);
    expect(input.baselineMethod).toContain('no counterfactual baseline');
  });

  it('treats manual outcomes as unverified', () => {
    const input = buildAgentROIInput(
      base({
        meta: new Map([['o1', { outcome_id: 'o1', source_system: 'manual', completion_status: 'completed' }]]),
      }),
    );
    expect(input.outcomes[0].outcome.source).toBe('manual');
    expect(input.outcomes[0].outcome.verified).toBe(false);
  });

  it('derives confidence sub-scores from coverage', () => {
    const input = buildAgentROIInput(
      base({
        vroi: [vroiRow({ outcome_id: 'o1', attribution_confidence: 1.0 }), vroiRow({ outcome_id: 'o2', attribution_confidence: 0.8 })],
        meta: new Map([
          ['o1', { outcome_id: 'o1', source_system: 'erp', completion_status: 'completed' }],
          ['o2', { outcome_id: 'o2', source_system: 'manual', completion_status: 'completed' }],
        ]),
        edges: new Map([['o1', { outcomeId: 'o1', counterfactualDelta: 0.5, attributionMethod: 'deterministic' }]]),
      }),
    );
    expect(input.confidence.attributionStrength).toBeCloseTo(0.9, 6); // (1.0 + 0.8)/2
    expect(input.confidence.causalStrength).toBeCloseTo(0.5, 6); // 1 of 2 has an edge
    expect(input.confidence.evidenceQuality).toBeCloseTo(0.5, 6); // 1 of 2 deterministic
    expect(input.confidence.outcomeVerification).toBeCloseTo(0.5, 6); // o2 manual → unverified
    expect(input.confidence.costCompleteness).toBeCloseTo(0.75, 6); // 3 of 4 cost buckets nonzero
  });

  it('picks the highest risk severity and maps an incident probability', () => {
    const input = buildAgentROIInput(base({ severity: 'high', riskEventCount: 4 }));
    expect(input.risk.severity).toBe('high');
    expect(input.risk.incidentProbability).toBe(0.3);
    expect(input.risk.riskEventCount).toBe(4);
    expect(input.risk.riskExposurePct).toBeCloseTo(0.1, 6);
  });
});

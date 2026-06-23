import { AgentROIInput } from './lari.types';

/**
 * Sample LARI input: a healthy, well-evidenced agent (InvoiceReviewAgent-style)
 * over a 30-day period. Two deterministic, verified outcomes with strong
 * incrementality, modest fully-loaded cost, low risk, high confidence — it should
 * compute to a strongly positive LARI and a `scale` recommendation. Used by the
 * README, the tests, and as a template for assembling inputs from live data.
 */
export const sampleAgentROIInput: AgentROIInput = {
  agentId: 'InvoiceReviewAgent',
  periodFrom: '2026-05-24',
  periodTo: '2026-06-23',
  outcomes: [
    {
      outcome: {
        outcomeId: 'out_inv_001',
        outcomeType: 'invoice_processed',
        grossValueUsd: 1500,
        source: 'deterministic',
        verified: true,
        occurredAt: '2026-06-20',
      },
      attributionConfidence: 0.95,
      incrementalityFactor: 0.8,
      attributionMethod: 'deterministic',
      evidenceRefs: ['erp:invoice/8821', 'session:run_inv_17'],
    },
    {
      outcome: {
        outcomeId: 'out_inv_002',
        outcomeType: 'invoice_processed',
        grossValueUsd: 1600,
        source: 'connector',
        verified: true,
        occurredAt: '2026-06-22',
      },
      attributionConfidence: 0.9,
      incrementalityFactor: 0.8,
      attributionMethod: 'probabilistic',
      evidenceRefs: ['erp:invoice/8830'],
    },
  ],
  cost: {
    tokenCostUsd: 2.7,
    humanReviewCostUsd: 40,
    infraCostUsd: 15,
    amortizedBuildCostUsd: 25,
  },
  risk: {
    severity: 'low',
    riskExposurePct: 0.05,
    incidentProbability: 0.1,
    riskEventCount: 0,
  },
  confidence: {
    evidenceQuality: 0.9,
    attributionStrength: 0.92,
    causalStrength: 0.8,
    costCompleteness: 1.0,
    outcomeVerification: 1.0,
    recency: 0.85,
  },
  baselineMethod: 'counterfactual delta from per-identity baseline (attribution engine v2)',
};

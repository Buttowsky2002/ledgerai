/**
 * LARI — BadgerIQ Risk-Adjusted Incremental ROI.
 *
 * Domain types for an explainable, DETERMINISTIC ROI engine. No type here carries
 * raw prompt/response content (security rule 2 + requirement 8) — only numeric and
 * categorical evidence and structural references. LLMs are never consulted to
 * decide a financial figure (requirement 7); they may, elsewhere, classify text or
 * summarize evidence into the categorical inputs below.
 *
 *   LARI = ( AttributedIncrementalValue
 *            - FullyLoadedAgentCost
 *            - ExpectedRiskLoss
 *            - UncertaintyReserve )
 *          / max(FullyLoadedAgentCost, epsilon)
 */

/** A single business outcome's gross value and provenance (no content). */
export interface OutcomeValue {
  outcomeId: string;
  outcomeType: string;
  /** Business value in USD if the agent received FULL credit (pre-attribution). */
  grossValueUsd: number;
  /** Where the value came from — drives verification + manual discounting. */
  source: 'deterministic' | 'connector' | 'manual' | 'api';
  /** True when a source system confirmed the outcome (not merely asserted). */
  verified: boolean;
  /** ISO timestamp the outcome occurred (drives the recency confidence factor). */
  occurredAt: string;
}

/** Links an outcome to the agent with attribution + incrementality (counterfactual). */
export interface OutcomeLink {
  outcome: OutcomeValue;
  /** P(agent caused/contributed) in [0,1] — from the attribution engine. */
  attributionConfidence: number;
  /** Counterfactual delta in [0,1]: the share of value that would NOT have
   *  happened without the agent (1 = fully incremental, 0 = would have happened anyway). */
  incrementalityFactor: number;
  attributionMethod: 'deterministic' | 'probabilistic' | 'shapley';
  /** Structural references only (PR URL, ticket key, session id) — never content. */
  evidenceRefs: string[];
}

/** Fully-loaded cost components in USD (requirement: human review + infra included). */
export interface CostBreakdown {
  /** LLM/token spend. */
  tokenCostUsd: number;
  /** Human-in-the-loop / QA review. */
  humanReviewCostUsd: number;
  /** Eval + monitoring + integration + platform share. */
  infraCostUsd: number;
  /** Amortized build/integration cost allocated to the period. */
  amortizedBuildCostUsd: number;
}

export type RiskSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Risk exposure for the agent over the period. */
export interface RiskBreakdown {
  severity: RiskSeverity;
  /** Fraction of value at risk in [0,1]. */
  riskExposurePct: number;
  /** Likelihood a risk event materializes in the period, in [0,1]. */
  incidentProbability: number;
  /** Optional explicit value-at-risk; else derived from value × exposure. */
  valueAtRiskUsd?: number;
  /** Count of governed risk events behind the exposure (for the ledger). */
  riskEventCount?: number;
}

/** Sub-scores in [0,1] that feed the weighted confidence score (0–100). */
export interface ConfidenceBreakdown {
  evidenceQuality: number;
  attributionStrength: number;
  causalStrength: number;
  costCompleteness: number;
  outcomeVerification: number;
  recency: number;
}

/** Everything the engine needs — fully self-contained and deterministic. */
export interface AgentROIInput {
  agentId: string;
  periodFrom: string;
  periodTo: string;
  outcomes: OutcomeLink[];
  cost: CostBreakdown;
  risk: RiskBreakdown;
  confidence: ConfidenceBreakdown;
  /** Human-readable description of how the incremental baseline was derived. */
  baselineMethod: string;
  /** How aggressively to reserve against low confidence (default 1.0). */
  uncertaintyReserveFactor?: number;
  /** Divide-by-zero guard for the denominator (default 1e-9). */
  epsilon?: number;
}

export type Recommendation =
  | 'scale'
  | 'maintain'
  | 'optimize'
  | 'improve_evidence'
  | 'require_approval'
  | 'investigate'
  | 'pause'
  | 'retire';

/** The auditable "why" behind every result — human-readable, content-free. */
export interface EvidenceLedger {
  valueDrivers: string[];
  costDrivers: string[];
  riskDrivers: string[];
  confidenceFactors: string[];
  attributionReasons: string[];
  baselineMethod: string;
  limitations: string[];
}

export interface AgentROIResult {
  agentId: string;
  period: { from: string; to: string };
  attributedIncrementalValueUsd: number;
  fullyLoadedCostUsd: number;
  expectedRiskLossUsd: number;
  uncertaintyReserveUsd: number;
  /** The LARI numerator (net risk-adjusted incremental value). */
  netValueUsd: number;
  /** The LARI ratio (net value / fully-loaded cost). */
  lari: number;
  /** Weighted confidence score in [0,100]. */
  confidenceScore: number;
  recommendation: Recommendation;
  ledger: EvidenceLedger;
  /** Echoed breakdowns so every figure traces to its inputs. */
  breakdown: {
    cost: CostBreakdown;
    risk: RiskBreakdown;
    confidence: ConfidenceBreakdown;
  };
}

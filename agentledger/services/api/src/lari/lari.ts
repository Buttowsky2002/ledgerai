/**
 * LARI — LedgerAI Risk-Adjusted Incremental ROI engine (deterministic).
 *
 * Pure, framework-free functions: given an AgentROIInput they always return the
 * same AgentROIResult. No I/O, no clock, no randomness, no LLM calls (requirement
 * 7) — `occurredAt`/period are supplied by the caller so results are reproducible
 * and unit-testable. The whole engine is auditable: every figure is echoed in the
 * evidence ledger with the drivers behind it.
 */
import {
  AgentROIInput,
  AgentROIResult,
  ConfidenceBreakdown,
  CostBreakdown,
  EvidenceLedger,
  OutcomeLink,
  Recommendation,
  RiskBreakdown,
  RiskSeverity,
} from './lari.types';

/** Confidence factor weights — sum to 1.0 (requirement 3). */
export const CONFIDENCE_WEIGHTS = {
  evidenceQuality: 0.25,
  attributionStrength: 0.2,
  causalStrength: 0.2,
  costCompleteness: 0.15,
  outcomeVerification: 0.1,
  recency: 0.1,
} as const;

/** Recommendation thresholds (named so they're auditable and easy to tune). */
export const LARI_THRESHOLDS = {
  /** Below this confidence, a positive ROI is not yet trustworthy. */
  confidenceTrust: 50,
  /** Confidence required (with a strong ratio) to recommend scaling. */
  confidenceScale: 70,
  /** Net return ratio at/above which a confident agent is scale-worthy (≥100%). */
  lariScale: 1.0,
  /** Positive but thin ratio below which to optimize cost rather than maintain. */
  lariOptimize: 0.25,
  /** Incremental value at/below this (with negative ROI) means retire, not investigate. */
  retireValueFloorUsd: 1,
} as const;

const DEFAULT_EPSILON = 1e-9;
const DEFAULT_UNCERTAINTY_FACTOR = 1.0;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const usd = (n: number): number => round(n, 2);

/**
 * AttributedIncrementalValue = Σ gross × attributionConfidence × incrementalityFactor.
 * Both factors are in [0,1], so gross value is discounted DOWN to the share the
 * agent both (a) plausibly caused and (b) that would not have happened anyway. A
 * manual outcome with low attribution confidence is therefore discounted heavily.
 */
export function calculateAttributedIncrementalValue(outcomes: OutcomeLink[]): number {
  return outcomes.reduce(
    (sum, l) =>
      sum + l.outcome.grossValueUsd * clamp01(l.attributionConfidence) * clamp01(l.incrementalityFactor),
    0,
  );
}

/** FullyLoadedCost = token + human review + infra + amortized build (requirement 6). */
export function calculateFullyLoadedCost(cost: CostBreakdown): number {
  return (
    (cost.tokenCostUsd || 0) +
    (cost.humanReviewCostUsd || 0) +
    (cost.infraCostUsd || 0) +
    (cost.amortizedBuildCostUsd || 0)
  );
}

/**
 * ExpectedRiskLoss = valueAtRisk × incidentProbability, where valueAtRisk is the
 * explicit figure if given, else attributedValue × riskExposurePct. Higher risk
 * (exposure and/or probability) strictly increases the loss, which reduces the
 * LARI numerator — so risk penalties always lower ROI.
 */
export function calculateExpectedRiskLoss(attributedValueUsd: number, risk: RiskBreakdown): number {
  const valueAtRisk =
    risk.valueAtRiskUsd !== undefined
      ? risk.valueAtRiskUsd
      : Math.max(0, attributedValueUsd) * clamp01(risk.riskExposurePct);
  return valueAtRisk * clamp01(risk.incidentProbability);
}

/** Weighted confidence score in [0,100] (requirement 3). */
export function calculateConfidenceScore(c: ConfidenceBreakdown): number {
  const w = CONFIDENCE_WEIGHTS;
  const score =
    100 *
    (w.evidenceQuality * clamp01(c.evidenceQuality) +
      w.attributionStrength * clamp01(c.attributionStrength) +
      w.causalStrength * clamp01(c.causalStrength) +
      w.costCompleteness * clamp01(c.costCompleteness) +
      w.outcomeVerification * clamp01(c.outcomeVerification) +
      w.recency * clamp01(c.recency));
  return round(score, 1);
}

/**
 * UncertaintyReserve = positiveValue × (1 - confidence/100) × factor. The lower the
 * confidence, the larger the slice of claimed value held back — so a high headline
 * value with weak evidence yields a low LARI (and an improve_evidence steer). Only
 * positive value is reserved against; we never reserve "against" a loss.
 */
export function calculateUncertaintyReserve(
  attributedValueUsd: number,
  confidenceScore: number,
  factor: number = DEFAULT_UNCERTAINTY_FACTOR,
): number {
  const uncertainty = clamp01(1 - confidenceScore / 100);
  return Math.max(0, attributedValueUsd) * uncertainty * Math.max(0, factor);
}

/**
 * The recommendation decision tree. Deterministic and ordered: critical risk gates
 * first, then ROI sign, then confidence, then ratio strength.
 */
export function recommendAgentAction(args: {
  lari: number;
  confidenceScore: number;
  severity: RiskSeverity;
  attributedIncrementalValueUsd: number;
}): Recommendation {
  const { lari, confidenceScore, severity, attributedIncrementalValueUsd } = args;
  const T = LARI_THRESHOLDS;

  // Critical risk gates everything: positive ROI needs human sign-off; a losing
  // agent that is also critically risky is paused outright.
  if (severity === 'critical') {
    return lari >= 0 ? 'require_approval' : 'pause';
  }

  // Losing money (non-critical risk): retire if it produces ~no value, else dig in.
  if (lari < 0) {
    return attributedIncrementalValueUsd <= T.retireValueFloorUsd ? 'retire' : 'investigate';
  }

  // Positive ROI but the evidence is too weak to trust the number yet.
  if (confidenceScore < T.confidenceTrust) {
    return 'improve_evidence';
  }

  // Confident, strongly positive → scale.
  if (lari >= T.lariScale && confidenceScore >= T.confidenceScale) {
    return 'scale';
  }
  // Confident but thin margin → squeeze cost before scaling.
  if (lari < T.lariOptimize) {
    return 'optimize';
  }
  // Solid, confident, mid-range → keep running as-is.
  return 'maintain';
}

/** Build the human-readable, content-free evidence ledger. */
function buildLedger(
  input: AgentROIInput,
  parts: {
    attributedIncrementalValueUsd: number;
    fullyLoadedCostUsd: number;
    expectedRiskLossUsd: number;
    uncertaintyReserveUsd: number;
    confidenceScore: number;
  },
): EvidenceLedger {
  const { cost, risk, confidence } = input;
  const w = CONFIDENCE_WEIGHTS;

  const valueDrivers = input.outcomes.map(
    (l) =>
      `${l.outcome.outcomeId} (${l.outcome.outcomeType}): gross $${usd(l.outcome.grossValueUsd)} ` +
      `× conf ${clamp01(l.attributionConfidence)} × incr ${clamp01(l.incrementalityFactor)} = ` +
      `$${usd(l.outcome.grossValueUsd * clamp01(l.attributionConfidence) * clamp01(l.incrementalityFactor))}`,
  );
  if (valueDrivers.length === 0) valueDrivers.push('no attributed outcomes in the period');

  const costDrivers = [
    `tokens $${usd(cost.tokenCostUsd)}`,
    `human review $${usd(cost.humanReviewCostUsd)}`,
    `infra (eval/monitoring/integration/platform) $${usd(cost.infraCostUsd)}`,
    `amortized build $${usd(cost.amortizedBuildCostUsd)}`,
    `fully-loaded $${usd(parts.fullyLoadedCostUsd)}`,
  ];

  const riskDrivers = [
    `severity ${risk.severity}`,
    `exposure ${clamp01(risk.riskExposurePct)} × incident prob ${clamp01(risk.incidentProbability)}`,
    `expected risk loss $${usd(parts.expectedRiskLossUsd)}`,
    ...(risk.riskEventCount !== undefined ? [`${risk.riskEventCount} governed risk event(s)`] : []),
  ];

  const f = (label: string, weight: number, value: number) =>
    `${label}: ${clamp01(value)} × ${weight} = ${round(weight * clamp01(value) * 100, 1)} pts`;
  const confidenceFactors = [
    f('evidence quality', w.evidenceQuality, confidence.evidenceQuality),
    f('attribution strength', w.attributionStrength, confidence.attributionStrength),
    f('causal strength', w.causalStrength, confidence.causalStrength),
    f('cost completeness', w.costCompleteness, confidence.costCompleteness),
    f('outcome verification', w.outcomeVerification, confidence.outcomeVerification),
    f('recency', w.recency, confidence.recency),
    `total ${parts.confidenceScore}/100`,
  ];

  const attributionReasons = input.outcomes.map(
    (l) =>
      `${l.outcome.outcomeId}: ${l.attributionMethod}` +
      (l.evidenceRefs.length ? ` [${l.evidenceRefs.join(', ')}]` : ' [no structural evidence]'),
  );

  const limitations: string[] = [];
  if (input.outcomes.some((l) => l.incrementalityFactor >= 1))
    limitations.push('one or more outcomes used full incrementality (no counterfactual baseline) — may overstate value');
  if (input.outcomes.some((l) => l.outcome.source === 'manual' || l.outcome.source === 'api'))
    limitations.push('manual/API-asserted outcomes present — discounted by attribution confidence, not independently verified');
  if (calculateFullyLoadedCost(cost) <= (input.epsilon ?? DEFAULT_EPSILON))
    limitations.push('near-zero fully-loaded cost — LARI ratio floored by epsilon and reads as very large');
  limitations.push('expected risk loss assumes a single independent incident per period (exposure × probability)');
  limitations.push('uncertainty reserve scales linearly with (1 − confidence); it is a holdback, not a measured loss');

  return {
    valueDrivers,
    costDrivers,
    riskDrivers,
    confidenceFactors,
    attributionReasons,
    baselineMethod: input.baselineMethod,
    limitations,
  };
}

/**
 * calculateRiskAdjustedROI — the orchestrator. Computes every component, the LARI
 * ratio, the confidence score, the recommendation, and the evidence ledger.
 */
export function calculateRiskAdjustedROI(input: AgentROIInput): AgentROIResult {
  const epsilon = input.epsilon ?? DEFAULT_EPSILON;

  const attributedIncrementalValueUsd = calculateAttributedIncrementalValue(input.outcomes);
  const fullyLoadedCostUsd = calculateFullyLoadedCost(input.cost);
  const expectedRiskLossUsd = calculateExpectedRiskLoss(attributedIncrementalValueUsd, input.risk);
  const confidenceScore = calculateConfidenceScore(input.confidence);
  const uncertaintyReserveUsd = calculateUncertaintyReserve(
    attributedIncrementalValueUsd,
    confidenceScore,
    input.uncertaintyReserveFactor ?? DEFAULT_UNCERTAINTY_FACTOR,
  );

  const netValueUsd =
    attributedIncrementalValueUsd - fullyLoadedCostUsd - expectedRiskLossUsd - uncertaintyReserveUsd;
  const lari = netValueUsd / Math.max(fullyLoadedCostUsd, epsilon);

  const recommendation = recommendAgentAction({
    lari,
    confidenceScore,
    severity: input.risk.severity,
    attributedIncrementalValueUsd,
  });

  const ledger = buildLedger(input, {
    attributedIncrementalValueUsd,
    fullyLoadedCostUsd,
    expectedRiskLossUsd,
    uncertaintyReserveUsd,
    confidenceScore,
  });

  return {
    agentId: input.agentId,
    period: { from: input.periodFrom, to: input.periodTo },
    attributedIncrementalValueUsd: usd(attributedIncrementalValueUsd),
    fullyLoadedCostUsd: usd(fullyLoadedCostUsd),
    expectedRiskLossUsd: usd(expectedRiskLossUsd),
    uncertaintyReserveUsd: usd(uncertaintyReserveUsd),
    netValueUsd: usd(netValueUsd),
    lari: round(lari, 4),
    confidenceScore,
    recommendation,
    ledger,
    breakdown: { cost: input.cost, risk: input.risk, confidence: input.confidence },
  };
}

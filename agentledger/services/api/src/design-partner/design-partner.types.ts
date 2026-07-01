import type { Recommendation } from '../lari/lari.types';

/** Built-in or custom design-partner onboarding profile. */
export interface DesignPartnerProfile {
  presentation: { from: string; to: string };
  agents: DesignPartnerAgent[];
  runs: DesignPartnerRun[];
  outcomes: DesignPartnerOutcome[];
  roiRates: DesignPartnerRoiRate[];
}

export interface DesignPartnerAgent {
  name: string;
  runtimeType?: string;
  riskPosture?: string;
  approvalStatus?: string;
}

export interface DesignPartnerRun {
  runId: string;
  agentId: string;
  appId?: string;
  userId?: string;
  startedAt: string;
  endedAt: string;
  status: string;
  objective?: string;
  outcomeId?: string;
  totalCostUsd: number;
  totalTokens: number;
  llmCalls: number;
  toolCalls: number;
  riskEvents: number;
}

export interface DesignPartnerOutcome {
  outcomeId: string;
  ts: string;
  sourceSystem: string;
  outcomeType: string;
  teamId?: string;
  userId?: string;
  businessValueUsd: number;
  qualityScore?: number;
  completionStatus: string;
}

export interface DesignPartnerRoiRate {
  sourceSystem: string;
  outcomeType: string;
  hourlyRate?: number;
  baselineMinutes?: number;
  reworkPct?: number;
  redeploymentFactor?: number;
  qaCostPerOutcome?: number;
  evalCostPerOutcome?: number;
  integrationCostPerOutcome?: number;
  platformOverheadPct?: number;
}

export interface LariAgentSummary {
  agentId: string;
  lari: number;
  netValueUsd: number;
  fullyLoadedCostUsd: number;
  confidenceScore: number;
  recommendation: Recommendation;
  outcomeCount: number;
}

export interface OnboardDesignPartnerReport {
  preset?: string;
  agentsRegistered: number;
  runsSeeded: number;
  outcomesSeeded: number;
  outcomesStamped: number;
  attributionEdges: number;
  vRoiRows: number;
  attributionTriggered: boolean;
  presentation: { from: string; to: string; dashboardHint: string };
  lari: LariAgentSummary[];
  ready: boolean;
}

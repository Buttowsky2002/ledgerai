/** GitHub Copilot Business connector — shared types. */

export const COPILOT_PROVIDER = 'github_copilot_business';
export const COPILOT_KIND = 'github-copilot-business';
export const COPILOT_CONNECTION_TYPE = 'license_usage_roi';

export const DEFAULT_SEAT_PRICE_USD = 19;
export const DEFAULT_INCLUDED_CREDITS_PER_SEAT = 1900;
export const DEFAULT_CREDIT_VALUE_USD = 0.01;

export interface CopilotRoiAssumptions {
  avgEngineerHourlyRate: number;
  minutesSavedPerAcceptedLine: number;
  minutesSavedPerChatTurn: number;
  minutesSavedPerPrSummary: number;
  qualityAdjustmentFactor: number;
  seatPriceUsd: number;
  includedCreditsPerSeat: number;
  creditValueUsd: number;
  inactiveDaysThreshold: number;
  lowUsageDaysThreshold: number;
  highRoiThreshold: number;
}

/** Conservative defaults — underestimate productivity vs. headline vendor claims. */
export const DEFAULT_ROI_ASSUMPTIONS: CopilotRoiAssumptions = {
  avgEngineerHourlyRate: 55,
  minutesSavedPerAcceptedLine: 0.25,
  minutesSavedPerChatTurn: 2,
  minutesSavedPerPrSummary: 5,
  qualityAdjustmentFactor: 0.5,
  seatPriceUsd: DEFAULT_SEAT_PRICE_USD,
  includedCreditsPerSeat: DEFAULT_INCLUDED_CREDITS_PER_SEAT,
  creditValueUsd: DEFAULT_CREDIT_VALUE_USD,
  inactiveDaysThreshold: 30,
  lowUsageDaysThreshold: 14,
  highRoiThreshold: 50,
};

export interface CopilotSeatRow {
  orgSlug: string;
  githubUserId: number;
  githubLogin: string;
  planType?: string;
  assigningTeamSlug?: string;
  seatCreatedAt?: Date;
  pendingCancellationDate?: Date;
  lastActivityAt?: Date;
  lastActivityEditor?: string;
  isActive: boolean;
  monthlySeatCost: number;
  rawPayload?: Record<string, unknown>;
}

export interface CopilotMemberRow {
  githubUserId: number;
  githubLogin: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  role?: string;
  isOrgMember: boolean;
}

export interface CopilotUsageRow {
  usageDate: string;
  githubLogin: string;
  teamSlug: string;
  editor: string;
  language: string;
  model: string;
  feature: string;
  suggestionsCount: number;
  acceptancesCount: number;
  linesSuggested: number;
  linesAccepted: number;
  activeUsers: number;
  engagedUsers: number;
  chatTurns: number;
  prSummaryCount: number;
  aiCreditsUsed: number;
  rawPayload: Record<string, unknown>;
}

/** One line from GitHub billing AI credit usage API (matches CSV export fields). */
export interface CopilotBillingLineRow {
  usageDate: string;
  githubLogin: string;
  product: string;
  sku: string;
  model: string;
  unitType: string;
  grossQuantity: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  rawPayload: Record<string, unknown>;
}

export interface CopilotRoiResult {
  assignedSeats: number;
  activeSeats: number;
  baseSeatCost: number;
  includedAiCredits: number;
  aiCreditsUsed: number;
  overageEstimate: number;
  totalCopilotCost: number;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  grossHoursSaved: number;
  adjustedHoursSaved: number;
  estimatedValue: number;
  roiPercentage: number;
}

export interface CopilotFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  estimatedImpactUsd?: number;
  affectedCount?: number;
}

export interface CopilotOverviewMetrics {
  monthlyCopilotSpend: number;
  activeSeats: number;
  inactiveSeats: number;
  aiCreditsUsed: number;
  creditUtilizationPct: number;
  estimatedHoursSaved: number;
  estimatedValueCreated: number;
  roiPercentage: number;
  costPerActiveUser: number;
  costPerEngagedUser: number;
  costPerAcceptedLine: number;
  isEstimated: true;
}

export interface CopilotOverviewCharts {
  spendByTeam: { team: string; spend: number }[];
  usageByFeature: { feature: string; count: number }[];
  aiCreditsByUser: { user: string; credits: number }[];
  acceptedLinesByLanguage: { language: string; lines: number }[];
  modelMix: { model: string; count: number }[];
  seatWaste: { bucket: string; seats: number; wasteUsd: number }[];
  roiByTeam: { team: string; roiPct: number; estimatedValue: number }[];
  adoptionTrend: { day: string; activeUsers: number; engagedUsers: number }[];
}

export interface CopilotConnectionStatus {
  connectionId: string;
  connectorId: string;
  orgSlug: string;
  displayName: string | null;
  status: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  recordsImported: number;
  roiAssumptions: CopilotRoiAssumptions;
}

export interface CreateCopilotConnectionDto {
  displayName: string;
  orgSlug: string;
  githubToken: string;
  enterpriseSlug?: string;
  roiAssumptions?: Partial<CopilotRoiAssumptions>;
  scheduleJson?: Record<string, unknown>;
}

export interface CopilotMemberSpendRow {
  githubLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  teamSlug: string;
  teamName: string;
  seatStatus: 'active' | 'inactive' | 'pending_cancel' | 'no_seat';
  lastActivityAt: string | null;
  seatCost: number;
  aiCreditsUsed: number;
  estimatedCreditCost: number;
  allocatedOverageCost: number;
  totalAllocatedCost: number;
  linesAccepted: number;
  chatTurns: number;
  prSummaryCount: number;
  estimatedHoursSaved: number;
  estimatedValueCreated: number;
  roiPercentage: number | null;
  utilizationStatus: string;
  isEstimated: boolean;
  costSource?: 'billing_api' | 'estimate';
  billedNetUsd?: number;
  billedGrossUsd?: number;
}

export interface CopilotMemberSpendSummary {
  totalCopilotSpend: number;
  allocatedMemberSpend: number;
  activePaidSeats: number;
  inactivePaidSeats: number;
  estimatedWastedSpend: number;
  avgCostPerActiveMember: number;
  avgCostPerEngagedMember: number;
  highestSpendMember: { login: string; cost: number } | null;
  highestRoiMember: { login: string; roiPct: number } | null;
  lowestRoiMember: { login: string; roiPct: number } | null;
  isEstimated: boolean;
}

export interface CopilotMemberSpendCharts {
  spendLeaderboard: { user: string; spend: number }[];
  spendByTeam: { team: string; spend: number }[];
  inactiveSeatWaste: { user: string; wasteUsd: number }[];
  aiCreditsByMember: { user: string; credits: number }[];
  roiByMember: { user: string; roiPct: number }[];
  costVsValue: { user: string; cost: number; value: number }[];
  acceptedLinesByMember: { user: string; lines: number }[];
  chatUsageByMember: { user: string; turns: number }[];
  usageTrendByDate: { day: string; spend: number; value: number }[];
  modelMix: { user: string; model: string; count: number }[];
}

export interface CopilotMemberSpendResponse {
  connected: boolean;
  summary: CopilotMemberSpendSummary | null;
  members: CopilotMemberSpendRow[];
  charts: CopilotMemberSpendCharts | null;
  findings: CopilotFinding[];
  filters: {
    teams: string[];
    users: string[];
    utilizationStatuses: string[];
    models: string[];
    editors: string[];
    languages: string[];
  };
  connections: CopilotConnectionStatus[];
  disclaimer: string;
  recordsImported: number;
}

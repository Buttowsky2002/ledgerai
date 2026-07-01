export interface CopilotRoiAssumptions {
  avgEngineerHourlyRate: number;
  minutesSavedPerAcceptedLine: number;
  minutesSavedPerChatTurn: number;
  minutesSavedPerPrSummary: number;
  qualityAdjustmentFactor: number;
  seatPriceUsd: number;
  includedCreditsPerSeat: number;
  creditValueUsd: number;
  inactiveDaysThreshold?: number;
  lowUsageDaysThreshold?: number;
  highRoiThreshold?: number;
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

export interface CopilotFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  estimatedImpactUsd?: number;
  affectedCount?: number;
}

export interface CopilotOverviewResponse {
  connected: boolean;
  metrics: CopilotOverviewMetrics | null;
  charts: {
    spendByTeam: { team: string; spend: number }[];
    usageByFeature: { feature: string; count: number }[];
    aiCreditsByUser: { user: string; credits: number }[];
    acceptedLinesByLanguage: { language: string; lines: number }[];
    modelMix: { model: string; count: number }[];
    seatWaste: { bucket: string; seats: number; wasteUsd: number }[];
    roiByTeam: { team: string; roiPct: number; estimatedValue: number }[];
    adoptionTrend: { day: string; activeUsers: number; engagedUsers: number }[];
  } | null;
  findings: CopilotFinding[];
  connections: CopilotConnectionStatus[];
  roiAssumptions?: CopilotRoiAssumptions;
  disclaimer: string;
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
  isEstimated: true;
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
  isEstimated: true;
}

export interface CopilotMemberSpendResponse {
  connected: boolean;
  summary: CopilotMemberSpendSummary | null;
  members: CopilotMemberSpendRow[];
  charts: {
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
  } | null;
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

export interface SyncResult {
  ok: boolean;
  seatsImported: number;
  membersImported?: number;
  teamLinksImported?: number;
  usageRowsImported: number;
  roiRowsComputed: number;
  memberSpendRowsComputed?: number;
  errorCode?: string;
  errorMessage?: string;
}

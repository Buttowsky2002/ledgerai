/** Tenant-level CFO view response — aggregates v_roi + supplemental LARI costs. */
export interface CfoViewSummary {
  riskAdjustedRoi: number;
  nominalRoi: number;
  businessValue: number;
  fullyLoadedCost: number;
  forecastPerMonth: number;
  roiMargin: number;
  runRateMonths: number;
}

export interface CfoViewMonthly {
  month: string;
  riskAdjustedRoi: number;
  nominalRoi: number;
  businessValue: number;
  fullyLoadedCost: number;
}

export interface CfoViewOutcomeBreakdown {
  outcomeType: string;
  outcomes: number;
  businessValue: number;
  fullyLoadedCost: number;
  nominalRoi: number;
  riskAdjustedRoi: number;
  avgConfidence: number;
}

export interface CfoViewProviderBreakdown {
  provider: string;
  costUsd: number;
  calls: number;
}

export interface CfoViewResponse {
  from: string;
  to: string;
  confidenceThreshold: number;
  summary: CfoViewSummary;
  monthly: CfoViewMonthly[];
  outcomeBreakdown: CfoViewOutcomeBreakdown[];
  providerBreakdown: CfoViewProviderBreakdown[];
  warnings: string[];
}

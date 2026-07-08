import type { PerUserAnalyticsMode } from '../tenant/per-user-analytics';

export type UserUtilizationStatus = 'active' | 'low_use' | 'inactive';

export interface UserUtilizationRow {
  userId: string;
  displayName: string;
  providers: string[];
  costUsd: number;
  calls: number;
  activeDays: number;
  codingAgentCostUsd: number;
  sessions: number;
  utilizationScore: number;
  seatMonthlyCostUsd: number;
  status: UserUtilizationStatus;
  hasSeat: boolean;
  planId?: string;
  planName?: string;
  seatProvider?: string;
  /** Daily cost series for anomaly detection (individual mode only). */
  dailyCost?: number[];
  /** Daily call series for anomaly detection (individual mode only). */
  dailyCalls?: number[];
}

export interface UserValueTeamAggregate {
  provisionedSeats: number;
  activeSeats: number;
  inactiveSeats: number;
  lowUseSeats: number;
  reclaimableMonthlyUsd: number;
  byPlan: Array<{
    planId: string;
    planName: string;
    provider: string;
    inactiveCount: number;
    reclaimableMonthlyUsd: number;
  }>;
  byProvider: Array<{
    provider: string;
    inactiveCount: number;
    reclaimableMonthlyUsd: number;
  }>;
}

export interface UserValueResponseBase {
  from: string;
  to: string;
  mode: PerUserAnalyticsMode;
}

export interface UserValueTeamResponse extends UserValueResponseBase {
  mode: 'team';
  aggregates: UserValueTeamAggregate;
}

export interface UserValueIndividualResponse extends UserValueResponseBase {
  mode: 'individual';
  users: UserUtilizationRow[];
}

export type UserValueResponse = UserValueTeamResponse | UserValueIndividualResponse;

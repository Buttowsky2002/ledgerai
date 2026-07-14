import { Injectable } from '@nestjs/common';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { calculateCursorDailyRoi, CursorDailyRoiResult } from './cursor-roi';

export const CURSOR_PRODUCTIVITY_OUTCOME_TYPE = 'cursor_code_activity';

export interface CursorProductivitySummary {
  estimatedValueUsd: number;
  linesCommitted: number;
  linesAccepted: number;
  activeUserDays: number;
  distinctUsers: number;
  avgConfidence: number;
  disclaimer: string;
}

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

@Injectable()
export class CursorProductivityService {
  constructor(private readonly ch: AnalyticsStore) {}

  async getProductivitySummary(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<CursorProductivitySummary | null> {
    const rows = await this.ch.queryScoped<{
      user_id: string;
      day: string;
      lines_accepted: unknown;
      lines_added: unknown;
      lines_deleted: unknown;
      lines_committed: unknown;
      tabs_accepted: unknown;
      composer_requests: unknown;
      chat_requests: unknown;
    }>(
      `SELECT user_id, day,
              sum(lines_accepted) AS lines_accepted,
              sum(lines_added) AS lines_added,
              sum(lines_deleted) AS lines_deleted,
              sum(lines_committed) AS lines_committed,
              sum(tabs_accepted) AS tabs_accepted,
              sum(composer_requests) AS composer_requests,
              sum(chat_requests) AS chat_requests
       FROM coding_agent_daily
       WHERE tenant_id = {tenant:String}
         AND provider = 'cursor'
         AND day BETWEEN {from:Date} AND {to:Date}
         AND user_id != ''
       GROUP BY user_id, day`,
      { tenant: tenantId, from, to },
    );

    if (rows.length === 0) return null;

    let estimatedValueUsd = 0;
    let linesCommitted = 0;
    let linesAccepted = 0;
    let activeUserDays = 0;
    const users = new Set<string>();
    let confidenceSum = 0;

    for (const row of rows) {
      const roi = calculateCursorDailyRoi({
        linesAccepted: Number(row.lines_accepted ?? 0),
        linesAdded: Number(row.lines_added ?? 0),
        linesDeleted: Number(row.lines_deleted ?? 0),
        linesCommitted: Number(row.lines_committed ?? 0),
        tabsAccepted: Number(row.tabs_accepted ?? 0),
        composerRequests: Number(row.composer_requests ?? 0),
        chatRequests: Number(row.chat_requests ?? 0),
      });
      if (roi.estimatedValueUsd <= 0 && roi.linesCommitted <= 0 && roi.linesAccepted <= 0) continue;
      activeUserDays += 1;
      users.add(String(row.user_id));
      estimatedValueUsd += roi.estimatedValueUsd;
      linesCommitted += roi.linesCommitted;
      linesAccepted += roi.linesAccepted;
      confidenceSum += roi.attributionConfidence;
    }

    if (activeUserDays === 0) return null;

    return {
      estimatedValueUsd: usd(estimatedValueUsd),
      linesCommitted,
      linesAccepted,
      activeUserDays,
      distinctUsers: users.size,
      avgConfidence: Math.round((confidenceSum / activeUserDays) * 100) / 100,
      disclaimer:
        'Cursor productivity value is estimated from Admin API daily usage (accepted AI lines, tabs, composer/chat). Lines committed uses totalLinesAdded from the editor — not git push events unless Enterprise commit analytics are connected.',
    };
  }

  /** Shape for CFO outcome breakdown row. */
  toOutcomeBreakdownRow(summary: CursorProductivitySummary, cursorSpendUsd: number): {
    outcomeType: string;
    outcomes: number;
    businessValue: number;
    fullyLoadedCost: number;
    nominalRoi: number;
    riskAdjustedRoi: number;
    avgConfidence: number;
    costPerOutcome: number;
  } {
    const businessValue = summary.estimatedValueUsd;
    const fullyLoadedCost = usd(cursorSpendUsd);
    const riskAdjustedValue = businessValue * summary.avgConfidence;
    return {
      outcomeType: CURSOR_PRODUCTIVITY_OUTCOME_TYPE,
      outcomes: summary.activeUserDays,
      businessValue,
      fullyLoadedCost,
      nominalRoi: usd(businessValue - fullyLoadedCost),
      riskAdjustedRoi: usd(riskAdjustedValue - fullyLoadedCost),
      avgConfidence: summary.avgConfidence,
      costPerOutcome: summary.activeUserDays > 0 ? usd(fullyLoadedCost / summary.activeUserDays) : 0,
    };
  }
}

export type { CursorDailyRoiResult };

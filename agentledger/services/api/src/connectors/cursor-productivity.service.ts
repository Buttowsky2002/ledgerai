import { Injectable } from '@nestjs/common';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { calculateCursorDailyRoi, CursorDailyRoiResult } from './cursor-roi';

export const CURSOR_PRODUCTIVITY_OUTCOME_TYPE = 'cursor_code_activity';

export interface CursorCommitAttributionSummary {
  commitCount: number;
  linesTotal: number;
  linesAi: number;
  aiSharePct: number;
  distinctUsers: number;
}

export interface CursorProductivitySummary {
  estimatedValueUsd: number;
  /** Committed AI lines from Enterprise attribution when available; else 0. */
  linesCommitted: number;
  linesAccepted: number;
  linesAdded: number;
  linesDeleted: number;
  activeUserDays: number;
  distinctUsers: number;
  avgConfidence: number;
  commitAttribution: CursorCommitAttributionSummary | null;
  disclaimer: string;
}

const usd = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

@Injectable()
export class CursorProductivityService {
  constructor(private readonly ch: AnalyticsStore) {}

  async getCommitAttributionSummary(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<CursorCommitAttributionSummary | null> {
    try {
      const rows = await this.ch.queryScoped<{
        commit_count: unknown;
        lines_total: unknown;
        lines_ai: unknown;
        distinct_users: unknown;
      }>(
        `SELECT
           count() AS commit_count,
           sum(lines_total) AS lines_total,
           sum(lines_ai) AS lines_ai,
           uniqExact(identity_email) AS distinct_users
         FROM coding_commit_attribution
         WHERE tenant_id = {tenant:String}
           AND source_tool = 'cursor'
           AND toDate(committed_at) BETWEEN {from:Date} AND {to:Date}`,
        { tenant: tenantId, from, to },
      );
      const row = rows[0];
      if (!row) return null;
      const commitCount = Number(row.commit_count ?? 0);
      if (commitCount <= 0) return null;
      const linesTotal = Number(row.lines_total ?? 0);
      const linesAi = Number(row.lines_ai ?? 0);
      return {
        commitCount,
        linesTotal,
        linesAi,
        aiSharePct: linesTotal > 0 ? Math.round((linesAi / linesTotal) * 10_000) / 100 : 0,
        distinctUsers: Number(row.distinct_users ?? 0),
      };
    } catch {
      // Table may not exist yet on older deployments — degrade cleanly.
      return null;
    }
  }

  async getProductivitySummary(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<CursorProductivitySummary | null> {
    const [rows, commitAttribution] = await Promise.all([
      this.ch.queryScoped<{
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
      ),
      this.getCommitAttributionSummary(tenantId, from, to),
    ]);

    if (rows.length === 0 && !commitAttribution) return null;

    let estimatedValueUsd = 0;
    let linesAccepted = 0;
    let linesAdded = 0;
    let linesDeleted = 0;
    let activeUserDays = 0;
    const users = new Set<string>();
    let confidenceSum = 0;

    for (const row of rows) {
      const roi = calculateCursorDailyRoi({
        linesAccepted: Number(row.lines_accepted ?? 0),
        linesAdded: Number(row.lines_added ?? 0),
        linesDeleted: Number(row.lines_deleted ?? 0),
        // Prefer Enterprise commit rollups; daily lines_committed stays 0 from Admin API.
        linesCommitted: 0,
        tabsAccepted: Number(row.tabs_accepted ?? 0),
        composerRequests: Number(row.composer_requests ?? 0),
        chatRequests: Number(row.chat_requests ?? 0),
      });
      if (roi.estimatedValueUsd <= 0 && roi.linesAccepted <= 0) continue;
      activeUserDays += 1;
      users.add(String(row.user_id));
      estimatedValueUsd += roi.estimatedValueUsd;
      linesAccepted += roi.linesAccepted;
      linesAdded += Number(row.lines_added ?? 0);
      linesDeleted += Number(row.lines_deleted ?? 0);
      confidenceSum += roi.attributionConfidence;
    }

    const linesCommitted = commitAttribution?.linesAi ?? 0;
    if (commitAttribution && activeUserDays > 0) {
      // Raise confidence when true commit attribution is present.
      confidenceSum = activeUserDays * 0.85;
    }

    if (activeUserDays === 0 && !commitAttribution) return null;

    const disclaimer = commitAttribution
      ? 'Accepted LOC and editor activity come from Cursor Admin daily-usage-data. Committed AI lines and AI share come from Enterprise /analytics/ai-code/commits. Background Agents and Cursor CLI are not tracked by Cursor.'
      : 'Cursor productivity value is estimated from Admin API daily usage (accepted AI lines, tabs, composer/chat). Committed AI LOC requires Enterprise AI Code Tracking (/analytics/ai-code/commits). Background Agents and Cursor CLI are not tracked by Cursor.';

    return {
      estimatedValueUsd: usd(estimatedValueUsd),
      linesCommitted,
      linesAccepted,
      linesAdded,
      linesDeleted,
      activeUserDays,
      distinctUsers: Math.max(users.size, commitAttribution?.distinctUsers ?? 0),
      avgConfidence:
        activeUserDays > 0
          ? Math.round((confidenceSum / activeUserDays) * 100) / 100
          : commitAttribution
            ? 0.85
            : 0,
      commitAttribution,
      disclaimer,
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
      outcomes: summary.activeUserDays || summary.commitAttribution?.commitCount || 0,
      businessValue,
      fullyLoadedCost,
      nominalRoi: usd(businessValue - fullyLoadedCost),
      riskAdjustedRoi: usd(riskAdjustedValue - fullyLoadedCost),
      avgConfidence: summary.avgConfidence,
      costPerOutcome:
        summary.activeUserDays > 0 ? usd(fullyLoadedCost / summary.activeUserDays) : 0,
    };
  }
}

export type { CursorDailyRoiResult };

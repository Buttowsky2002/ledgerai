import type { PilotReport } from './report.renderer';

// Pure post-query shaping for AnalyticsService.sourceReconciliation and
// AnalyticsService.pilotReport. The service still owns every ClickHouse query;
// these functions only turn already-fetched rows into the response DTOs, so the
// two report methods stay thin and the shaping is unit-testable in isolation.

/** Coerce a ClickHouse scalar (numbers may arrive as strings) to a number. */
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/** One day of portal vs API spend for reconciliation (Admin billing import). */
export interface SourceReconciliationDay {
  day: string;
  portalCostUsd: number;
  portalCalls: number;
  apiCostUsd: number;
  apiCalls: number;
}

export interface SourceReconciliationResult {
  from: string;
  to: string;
  days: SourceReconciliationDay[];
  summary: {
    portalTotalUsd: number;
    apiTotalUsd: number;
    overlapDays: number;
    portalOnlyDays: number;
    apiOnlyDays: number;
  };
}

/** Raw reconciliation row as returned by ClickHouse (scalars may be strings). */
export interface SourceReconciliationRow {
  day: string;
  portal_cost_usd: unknown;
  portal_calls: unknown;
  api_cost_usd: unknown;
  api_calls: unknown;
}

export function buildSourceReconciliation(
  rows: SourceReconciliationRow[],
  range: { from: string; to: string },
): SourceReconciliationResult {
  const days: SourceReconciliationDay[] = rows.map((row) => ({
    day: String(row.day).slice(0, 10),
    portalCostUsd: n(row.portal_cost_usd),
    portalCalls: n(row.portal_calls),
    apiCostUsd: n(row.api_cost_usd),
    apiCalls: n(row.api_calls),
  }));

  let portalTotalUsd = 0;
  let apiTotalUsd = 0;
  let overlapDays = 0;
  let portalOnlyDays = 0;
  let apiOnlyDays = 0;
  for (const d of days) {
    portalTotalUsd += d.portalCostUsd;
    apiTotalUsd += d.apiCostUsd;
    const hasPortal = d.portalCostUsd > 0;
    const hasApi = d.apiCostUsd > 0;
    if (hasPortal && hasApi) {
      overlapDays++;
    } else if (hasPortal) {
      portalOnlyDays++;
    } else if (hasApi) {
      apiOnlyDays++;
    }
  }

  return {
    from: range.from,
    to: range.to,
    days,
    summary: { portalTotalUsd, apiTotalUsd, overlapDays, portalOnlyDays, apiOnlyDays },
  };
}

/** The six ClickHouse result sets pilotReport assembles into a PilotReport. */
export interface PilotReportParts {
  spendTotals: Record<string, unknown>[];
  byProvider: Record<string, unknown>[];
  agents: Record<string, unknown>[];
  unit: Record<string, unknown>[];
  roi: Record<string, unknown>[];
  severity: Record<string, unknown>[];
}

export function buildPilotReport(
  parts: PilotReportParts,
  window: { from: string; to: string; days: number },
  minConfidence: number,
): PilotReport {
  const st = (parts.spendTotals[0] ?? {}) as Record<string, unknown>;
  const ue = (parts.unit[0] ?? {}) as Record<string, unknown>;
  const ro = (parts.roi[0] ?? {}) as Record<string, unknown>;
  const sevRows = parts.severity;

  return {
    window: { from: window.from, to: window.to, days: window.days },
    spend: {
      source: 'llm_calls (metered)',
      totalCostUsd: n(st.cost_usd),
      calls: n(st.calls),
      inputTokens: n(st.input_tokens),
      outputTokens: n(st.output_tokens),
      blockedCalls: n(st.blocked_calls),
      errorCalls: n(st.error_calls),
      byProvider: parts.byProvider.map((x) => ({
        provider: String(x.provider),
        costUsd: n(x.cost_usd),
        calls: n(x.calls),
      })),
    },
    topAgents: {
      source: 'spend_hourly_by_key',
      agents: parts.agents.map((x) => ({
        agentId: String(x.agent_id),
        costUsd: n(x.cost_usd),
        calls: n(x.calls),
      })),
    },
    unitEconomics: {
      source: 'outcomes + agent_runs',
      minConfidence,
      outcomes: n(ue.outcomes),
      aiCostUsd: n(ue.ai_cost_usd),
      businessValueUsd: n(ue.business_value_usd),
      costPerOutcome: n(ue.cost_per_outcome),
      netValueUsd: n(ue.net_value_usd),
      avgConfidence: n(ue.avg_confidence),
    },
    roi: {
      source: 'v_roi',
      minConfidence,
      outcomes: n(ro.outcomes),
      valueUsd: n(ro.value_usd),
      fullyLoadedCostUsd: n(ro.fully_loaded_cost_usd),
      expectedRoiUsd: n(ro.expected_roi_usd),
      riskAdjustedRoiUsd: n(ro.risk_adjusted_roi_usd),
      roiLowUsd: n(ro.roi_low_usd),
      roiHighUsd: n(ro.roi_high_usd),
      avgConfidence: n(ro.avg_confidence),
    },
    governance: {
      source: 'risk_daily',
      bySeverity: sevRows
        .filter((x) => String(x.severity) !== '')
        .map((x) => ({ severity: String(x.severity), events: n(x.total_events) })),
      dlpBlockEvents: sevRows.reduce((s, x) => s + n(x.dlp_block_events), 0),
      highSeverityEvents: sevRows.reduce((s, x) => s + n(x.high_events), 0),
    },
  };
}

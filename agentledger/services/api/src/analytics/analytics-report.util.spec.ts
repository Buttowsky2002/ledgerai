import {
  buildPilotReport,
  buildSourceReconciliation,
  type PilotReportParts,
  type SourceReconciliationRow,
} from './analytics-report.util';

describe('buildSourceReconciliation', () => {
  const range = { from: '2026-01-01', to: '2026-01-03' };

  it('maps rows to days and coerces string scalars', () => {
    const rows: SourceReconciliationRow[] = [
      {
        day: '2026-01-01T00:00:00',
        portal_cost_usd: '10.5',
        portal_calls: '3',
        api_cost_usd: 0,
        api_calls: 0,
      },
    ];
    const result = buildSourceReconciliation(rows, range);
    expect(result.days).toEqual([
      { day: '2026-01-01', portalCostUsd: 10.5, portalCalls: 3, apiCostUsd: 0, apiCalls: 0 },
    ]);
    expect(result.from).toBe('2026-01-01');
    expect(result.to).toBe('2026-01-03');
  });

  it('classifies overlap, portal-only, and api-only days', () => {
    const rows: SourceReconciliationRow[] = [
      { day: '2026-01-01', portal_cost_usd: 10, portal_calls: 1, api_cost_usd: 5, api_calls: 1 },
      { day: '2026-01-02', portal_cost_usd: 8, portal_calls: 1, api_cost_usd: 0, api_calls: 0 },
      { day: '2026-01-03', portal_cost_usd: 0, portal_calls: 0, api_cost_usd: 4, api_calls: 1 },
    ];
    const { summary } = buildSourceReconciliation(rows, range);
    expect(summary.portalTotalUsd).toBe(18);
    expect(summary.apiTotalUsd).toBe(9);
    expect(summary.overlapDays).toBe(1);
    expect(summary.portalOnlyDays).toBe(1);
    expect(summary.apiOnlyDays).toBe(1);
  });

  it('returns an empty result for no rows', () => {
    const { days, summary } = buildSourceReconciliation([], range);
    expect(days).toEqual([]);
    expect(summary).toEqual({
      portalTotalUsd: 0,
      apiTotalUsd: 0,
      overlapDays: 0,
      portalOnlyDays: 0,
      apiOnlyDays: 0,
    });
  });
});

describe('buildPilotReport', () => {
  const window = { from: '2026-01-01', to: '2026-01-31', days: 30 };

  const parts: PilotReportParts = {
    spendTotals: [
      {
        cost_usd: '120',
        calls: 40,
        input_tokens: 1000,
        output_tokens: 500,
        blocked_calls: 2,
        error_calls: 1,
      },
    ],
    byProvider: [{ provider: 'anthropic', cost_usd: '100', calls: 30 }],
    agents: [{ agent_id: 'agent-1', cost_usd: 60, calls: 20 }],
    unit: [
      {
        outcomes: 5,
        ai_cost_usd: 50,
        business_value_usd: 500,
        cost_per_outcome: 10,
        net_value_usd: 450,
        avg_confidence: '0.8',
      },
    ],
    roi: [
      {
        outcomes: 5,
        value_usd: 500,
        fully_loaded_cost_usd: 80,
        expected_roi_usd: 420,
        risk_adjusted_roi_usd: 380,
        roi_low_usd: 300,
        roi_high_usd: 500,
        avg_confidence: 0.75,
      },
    ],
    severity: [
      { severity: 'high', total_events: 4, dlp_block_events: 1, high_events: 4 },
      { severity: '', total_events: 9, dlp_block_events: 2, high_events: 0 },
    ],
  };

  it('assembles spend, agents, unit economics, and roi from row[0]', () => {
    const report = buildPilotReport(parts, window, 0.5);
    expect(report.window).toEqual(window);
    expect(report.spend.totalCostUsd).toBe(120);
    expect(report.spend.byProvider).toEqual([{ provider: 'anthropic', costUsd: 100, calls: 30 }]);
    expect(report.topAgents.agents).toEqual([{ agentId: 'agent-1', costUsd: 60, calls: 20 }]);
    expect(report.unitEconomics.minConfidence).toBe(0.5);
    expect(report.unitEconomics.avgConfidence).toBe(0.8);
    expect(report.roi.riskAdjustedRoiUsd).toBe(380);
    expect(report.roi.minConfidence).toBe(0.5);
  });

  it('drops the blank severity bucket but keeps it in the reduces', () => {
    const report = buildPilotReport(parts, window, 0.5);
    expect(report.governance.bySeverity).toEqual([{ severity: 'high', events: 4 }]);
    expect(report.governance.dlpBlockEvents).toBe(3);
    expect(report.governance.highSeverityEvents).toBe(4);
  });

  it('produces zeros when the result sets are empty', () => {
    const empty: PilotReportParts = {
      spendTotals: [],
      byProvider: [],
      agents: [],
      unit: [],
      roi: [],
      severity: [],
    };
    const report = buildPilotReport(empty, window, 0.5);
    expect(report.spend.totalCostUsd).toBe(0);
    expect(report.spend.byProvider).toEqual([]);
    expect(report.topAgents.agents).toEqual([]);
    expect(report.roi.valueUsd).toBe(0);
    expect(report.governance.bySeverity).toEqual([]);
    expect(report.governance.dlpBlockEvents).toBe(0);
  });
});

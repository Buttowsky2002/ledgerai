import { PilotReport, renderMarkdown } from './report.renderer';

const sample: PilotReport = {
  window: { from: '2026-05-22', to: '2026-06-21', days: 30 },
  spend: {
    source: 'spend_daily',
    totalCostUsd: 123.456,
    calls: 1500,
    inputTokens: 1_000_000,
    outputTokens: 400_000,
    blockedCalls: 3,
    errorCalls: 1,
    byProvider: [{ provider: 'openai', costUsd: 100, calls: 1200 }],
  },
  topAgents: { source: 'spend_hourly_by_key', agents: [{ agentId: 'agent-x', costUsd: 80, calls: 900 }] },
  unitEconomics: {
    source: 'outcomes + agent_runs',
    minConfidence: 0.5,
    outcomes: 10,
    aiCostUsd: 50,
    businessValueUsd: 5000,
    costPerOutcome: 5,
    netValueUsd: 4950,
    avgConfidence: 0.92,
  },
  roi: {
    source: 'v_roi',
    minConfidence: 0.5,
    outcomes: 10,
    valueUsd: 5000,
    fullyLoadedCostUsd: 75,
    expectedRoiUsd: 4600,
    riskAdjustedRoiUsd: 4400,
    roiLowUsd: 4000,
    roiHighUsd: 4900,
    avgConfidence: 0.92,
  },
  governance: {
    source: 'risk_daily',
    bySeverity: [{ severity: 'high', events: 2 }],
    dlpBlockEvents: 3,
    highSeverityEvents: 2,
  },
};

describe('renderMarkdown', () => {
  const md = renderMarkdown(sample);

  it('renders the title, window, and every section heading', () => {
    expect(md).toContain('# AgentLedger Pilot Report');
    expect(md).toContain('2026-05-22 → 2026-06-21 (30 days)');
    for (const h of ['## Spend', '## Top agents', '## Unit economics', '## Risk-adjusted ROI', '## Governance posture']) {
      expect(md).toContain(h);
    }
  });

  it('cites the source view for each section (traceability)', () => {
    expect(md).toContain('source: spend_daily');
    expect(md).toContain('source: spend_hourly_by_key');
    expect(md).toContain('source: outcomes + agent_runs');
    expect(md).toContain('source: v_roi');
    expect(md).toContain('source: risk_daily');
  });

  it('formats currency and the risk-adjusted ROI figure', () => {
    expect(md).toContain('$123.46'); // total cost, 2dp
    expect(md).toContain('Risk-adjusted ROI:** $4400.00');
    expect(md).toContain('$4000.00 – $4900.00'); // ROI range
  });

  it('falls back gracefully when there are no agents', () => {
    const empty = renderMarkdown({ ...sample, topAgents: { source: 'spend_hourly_by_key', agents: [] } });
    expect(empty).toContain('_No agent-attributed spend in this window._');
  });
});

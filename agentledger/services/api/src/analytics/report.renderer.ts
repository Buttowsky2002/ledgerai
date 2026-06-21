// 30-day pilot report (P6-E2, ADR-036). The report aggregates existing ClickHouse
// views into a board-ready trial summary; every section carries the `source` view
// it came from so each figure traces back to source events (the Phase 4
// acceptance bar). This file owns the report's shape + a hand-rolled Markdown
// renderer (no templating dependency, rule 12).

export interface PilotReport {
  window: { from: string; to: string; days: number };
  spend: {
    source: string;
    totalCostUsd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    blockedCalls: number;
    errorCalls: number;
    byProvider: { provider: string; costUsd: number; calls: number }[];
  };
  topAgents: {
    source: string;
    agents: { agentId: string; costUsd: number; calls: number }[];
  };
  unitEconomics: {
    source: string;
    minConfidence: number;
    outcomes: number;
    aiCostUsd: number;
    businessValueUsd: number;
    costPerOutcome: number;
    netValueUsd: number;
    avgConfidence: number;
  };
  roi: {
    source: string;
    minConfidence: number;
    outcomes: number;
    valueUsd: number;
    fullyLoadedCostUsd: number;
    expectedRoiUsd: number;
    riskAdjustedRoiUsd: number;
    roiLowUsd: number;
    roiHighUsd: number;
    avgConfidence: number;
  };
  governance: {
    source: string;
    bySeverity: { severity: string; events: number }[];
    dlpBlockEvents: number;
    highSeverityEvents: number;
  };
}

const usd = (n: number) => `$${(n ?? 0).toFixed(2)}`;
const int = (n: number) => Math.round(n ?? 0).toLocaleString('en-US');
const pct = (n: number) => `${((n ?? 0) * 100).toFixed(1)}%`;

/** Render a PilotReport as Markdown (email/PDF precursor). */
export function renderMarkdown(r: PilotReport): string {
  const L: string[] = [];
  L.push(`# AgentLedger Pilot Report`);
  L.push('');
  L.push(`**Window:** ${r.window.from} → ${r.window.to} (${r.window.days} days)`);
  L.push('');

  L.push(`## Spend  _(source: ${r.spend.source})_`);
  L.push(`- **Total cost:** ${usd(r.spend.totalCostUsd)} across ${int(r.spend.calls)} calls`);
  L.push(`- **Tokens:** ${int(r.spend.inputTokens)} in / ${int(r.spend.outputTokens)} out`);
  L.push(`- **Blocked / errored calls:** ${int(r.spend.blockedCalls)} / ${int(r.spend.errorCalls)}`);
  if (r.spend.byProvider.length) {
    L.push('');
    L.push('| Provider | Cost | Calls |');
    L.push('| --- | --- | --- |');
    for (const p of r.spend.byProvider) {
      L.push(`| ${p.provider} | ${usd(p.costUsd)} | ${int(p.calls)} |`);
    }
  }
  L.push('');

  L.push(`## Top agents by cost  _(source: ${r.topAgents.source})_`);
  if (r.topAgents.agents.length) {
    L.push('| Agent | Cost | Calls |');
    L.push('| --- | --- | --- |');
    for (const a of r.topAgents.agents) {
      L.push(`| ${a.agentId} | ${usd(a.costUsd)} | ${int(a.calls)} |`);
    }
  } else {
    L.push('_No agent-attributed spend in this window._');
  }
  L.push('');

  L.push(`## Unit economics  _(source: ${r.unitEconomics.source}, confidence ≥ ${r.unitEconomics.minConfidence})_`);
  L.push(`- **Outcomes:** ${int(r.unitEconomics.outcomes)}`);
  L.push(`- **AI cost:** ${usd(r.unitEconomics.aiCostUsd)} · **Business value:** ${usd(r.unitEconomics.businessValueUsd)}`);
  L.push(`- **Cost per outcome:** ${usd(r.unitEconomics.costPerOutcome)} · **Net value:** ${usd(r.unitEconomics.netValueUsd)}`);
  L.push(`- **Avg attribution confidence:** ${pct(r.unitEconomics.avgConfidence)}`);
  L.push('');

  L.push(`## Risk-adjusted ROI  _(source: ${r.roi.source}, headline confidence ≥ ${r.roi.minConfidence})_`);
  L.push(`- **Value:** ${usd(r.roi.valueUsd)} · **Fully-loaded cost:** ${usd(r.roi.fullyLoadedCostUsd)}`);
  L.push(`- **Expected ROI:** ${usd(r.roi.expectedRoiUsd)} · **Risk-adjusted ROI:** ${usd(r.roi.riskAdjustedRoiUsd)}`);
  L.push(`- **ROI range:** ${usd(r.roi.roiLowUsd)} – ${usd(r.roi.roiHighUsd)}`);
  L.push('');

  L.push(`## Governance posture  _(source: ${r.governance.source})_`);
  L.push(`- **DLP blocks:** ${int(r.governance.dlpBlockEvents)} · **High-severity risk events:** ${int(r.governance.highSeverityEvents)}`);
  if (r.governance.bySeverity.length) {
    L.push('');
    L.push('| Severity | Events |');
    L.push('| --- | --- |');
    for (const s of r.governance.bySeverity) {
      L.push(`| ${s.severity} | ${int(s.events)} |`);
    }
  }
  L.push('');
  return L.join('\n');
}

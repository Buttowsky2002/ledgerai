import { Card, DataTable, PageHeader, Stat, num } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';

export const dynamic = 'force-dynamic';

type AgentRiskRow = {
  agent_id: string;
  risk_exposure_pct: number | string;
  events: number | string;
  high_severity: number | string;
  latest_detail: string;
  latest_category: string;
  last_detected: string;
};

const pct = (n: number | string) => `${(Number(n) * 100).toFixed(1)}%`;

export default async function CisoPage() {
  const api = apiClient();
  const rows = (await fetchData(
    api.GET('/v1/analytics/agent-risk', {}),
    [],
  )) as unknown as AgentRiskRow[];

  const agentsAtRisk = rows.filter((r) => Number(r.risk_exposure_pct) > 0).length;
  const totalEvents = rows.reduce((s, r) => s + Number(r.events), 0);
  const highSeverity = rows.reduce((s, r) => s + Number(r.high_severity), 0);
  const peakExposure = rows.reduce((m, r) => Math.max(m, Number(r.risk_exposure_pct)), 0);

  return (
    <>
      <PageHeader
        title="CISO view"
        subtitle="Agent governance posture — tool/MCP risk events and exposure"
      />
      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Agents at risk" value={num(agentsAtRisk)} sub={`${num(rows.length)} with governed events`} />
        <Stat label="Governed risk events" value={num(totalEvents)} />
        <Stat label="High severity" value={num(highSeverity)} />
        <Stat label="Peak risk exposure" value={pct(peakExposure)} sub="discounts risk-adjusted ROI" />
      </div>
      <p className="mb-6 text-xs text-muted">
        Risk events are raised when an agent uses a tool/MCP outside its deny-by-default allowlist. Each agent&apos;s
        risk exposure (unauthorized ÷ total tool calls) lowers its risk-adjusted ROI in the CFO view.
      </p>
      <Card title="Agent risk register">
        <DataTable
          columns={[
            { key: 'agent', label: 'Agent' },
            { key: 'exposure', label: 'Risk exposure', align: 'right' },
            { key: 'events', label: 'Events', align: 'right' },
            { key: 'high', label: 'High severity', align: 'right' },
            { key: 'latest', label: 'Latest finding' },
            { key: 'when', label: 'Last detected' },
          ]}
          rows={rows.map((r) => ({
            agent: r.agent_id,
            exposure: pct(r.risk_exposure_pct),
            events: num(r.events),
            high: num(r.high_severity),
            latest: r.latest_category ? `${r.latest_category}: ${r.latest_detail || '—'}` : '—',
            when: String(r.last_detected).slice(0, 19),
          }))}
        />
      </Card>
    </>
  );
}

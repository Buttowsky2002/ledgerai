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

type InjectionPostureRow = {
  agent_id: string;
  blocked_count: number | string;
  last_blocked: string;
  flagged_count: number | string;
  high_severity: number | string;
  latest_detail: string;
  last_detected: string;
};

const pct = (n: number | string) => `${(Number(n) * 100).toFixed(1)}%`;

export default async function CisoPage() {
  const api = apiClient();
  const [rows, injectionRows] = await Promise.all([
    fetchData(api.GET('/v1/analytics/agent-risk', {}), []) as unknown as Promise<AgentRiskRow[]>,
    fetchData(api.GET('/v1/analytics/injection', {}), []) as unknown as Promise<InjectionPostureRow[]>,
  ]);

  const agentsAtRisk = rows.filter((r) => Number(r.risk_exposure_pct) > 0).length;
  const totalEvents = rows.reduce((s, r) => s + Number(r.events), 0);
  const highSeverity = rows.reduce((s, r) => s + Number(r.high_severity), 0);
  const peakExposure = rows.reduce((m, r) => Math.max(m, Number(r.risk_exposure_pct)), 0);

  const inlineBlocks = injectionRows.reduce((s, r) => s + Number(r.blocked_count), 0);
  const semanticFlags = injectionRows.reduce((s, r) => s + Number(r.flagged_count), 0);
  const injectionHigh = injectionRows.reduce((s, r) => s + Number(r.high_severity), 0);
  const agentsAffected = injectionRows.length;

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
      <div className="mb-6 mt-8 grid grid-cols-4 gap-4">
        <Stat label="Injection blocks (inline)" value={num(inlineBlocks)} sub="high-confidence patterns" />
        <Stat label="Suspected (semantic)" value={num(semanticFlags)} sub="async tool-sequence tier" />
        <Stat label="High severity" value={num(injectionHigh)} />
        <Stat label="Agents affected" value={num(agentsAffected)} />
      </div>
      <p className="mb-6 text-xs text-muted">
        Defense-in-depth with confidence scoring — not complete protection. The inline tier blocks known
        high-confidence patterns in the request path (prompt text and untrusted MCP tool_result content on
        the next turn). The async tier flags behavioral cases from tool/MCP call sequences. Together they
        raise the cost of injection but residual risk remains.
      </p>
      <Card title="Injection posture">
        <DataTable
          columns={[
            { key: 'agent', label: 'Agent' },
            { key: 'blocked', label: 'Blocked inline', align: 'right' },
            { key: 'flagged', label: 'Suspected (async)', align: 'right' },
            { key: 'high', label: 'High severity', align: 'right' },
            { key: 'latest', label: 'Latest finding' },
            { key: 'when', label: 'Last seen' },
          ]}
          rows={injectionRows.map((r) => ({
            agent: r.agent_id,
            blocked: num(r.blocked_count),
            flagged: num(r.flagged_count),
            high: num(r.high_severity),
            latest: r.latest_detail || '—',
            when: String(r.last_blocked || r.last_detected || '').slice(0, 19) || '—',
          }))}
        />
      </Card>
    </>
  );
}

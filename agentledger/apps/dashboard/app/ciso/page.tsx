import { Card, DataTable, PageHeader, Stat, num } from '../../components/ui';
import { BlastRadiusTable, type BlastRadiusRow } from '../../components/ciso/BlastRadiusTable';
import {
  ToolAllowlistPanel,
  type AgentOption,
  type AllowlistRow,
} from '../../components/ciso/ToolAllowlistPanel';
import { apiClient, fetchData, proxyApi } from '../../lib/api';

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
  const [rows, allowRes, blastRes, agentsRaw, meRes] = await Promise.all([
    fetchData(api.GET('/v1/analytics/agent-risk', {}), []) as Promise<AgentRiskRow[]>,
    proxyApi('/v1/agent-tool-allowlist?limit=200&offset=0'),
    proxyApi('/v1/agent-credentials/blast-radius'),
    fetchData(
      api.GET('/v1/agents', { params: { query: { limit: '200', offset: '0' } } }),
      [],
    ) as Promise<AgentOption[]>,
    proxyApi('/auth/me'),
  ]);

  const allowlist: AllowlistRow[] = Array.isArray(allowRes.data)
    ? (allowRes.data as AllowlistRow[])
    : [];
  const blastRows: BlastRadiusRow[] = Array.isArray(blastRes.data)
    ? (blastRes.data as BlastRadiusRow[])
    : [];
  const agents: AgentOption[] = Array.isArray(agentsRaw)
    ? agentsRaw.map((a) => ({ agentId: a.agentId, name: a.name }))
    : [];

  const me =
    meRes.ok && meRes.data && typeof meRes.data === 'object' && 'role' in meRes.data
      ? (meRes.data as { role?: string })
      : null;
  const canManage = me?.role === 'admin';

  const agentsAtRisk = rows.filter((r) => Number(r.risk_exposure_pct) > 0).length;
  const totalEvents = rows.reduce((s, r) => s + Number(r.events), 0);
  const highSeverity = rows.reduce((s, r) => s + Number(r.high_severity), 0);
  const peakExposure = rows.reduce((m, r) => Math.max(m, Number(r.risk_exposure_pct)), 0);
  const activeCredAgents = blastRows.filter((r) => r.activeCredentials > 0).length;

  return (
    <>
      <PageHeader
        title="CISO view"
        subtitle="Agent governance posture — tool/MCP risk events, allowlists, and NHI blast radius"
      />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Agents at risk" value={num(agentsAtRisk)} sub={`${num(rows.length)} with governed events`} />
        <Stat label="Governed risk events" value={num(totalEvents)} />
        <Stat label="High severity" value={num(highSeverity)} />
        <Stat label="Peak risk exposure" value={pct(peakExposure)} sub="discounts risk-adjusted ROI" />
        <Stat label="Agents with active NHI" value={num(activeCredAgents)} sub={`${num(blastRows.length)} agents`} />
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

      <Card title="NHI blast radius">
        <p className="mb-3 text-xs text-muted">
          Active non-human credentials and allowlisted tool surface area per agent.
        </p>
        <BlastRadiusTable rows={blastRows} />
      </Card>

      <Card title="Tool / MCP allowlist">
        <ToolAllowlistPanel entries={allowlist} agents={agents} canManage={canManage} />
      </Card>
    </>
  );
}

import Link from 'next/link';
import { LineChartClient } from '../components/charts';
import { Card, DataTable, PageHeader, Stat, num, usd } from '../components/ui';
import { apiClient, fetchData } from '../lib/api';
import { defaultRange } from '../lib/auth';

export const dynamic = 'force-dynamic';

type SpendRow = {
  day: string;
  cost_usd: number | string;
  calls: string;
  tokens: string;
  blocked_calls: string;
  error_calls: string;
};

type Team = { id: string; name: string };

type Recommendation =
  | 'scale'
  | 'maintain'
  | 'optimize'
  | 'improve_evidence'
  | 'require_approval'
  | 'investigate'
  | 'pause'
  | 'retire';

type AgentEconomicsRow = {
  agentId: string;
  cost_usd: number;
  value_usd: number;
  risk_adjusted_roi: number;
  lari: number;
  confidenceScore: number;
  recommendation: Recommendation;
};

// Presentation for each LARI recommendation: label, badge color, and whether it
// is an action item worth surfacing in the "Recommended actions" panel.
const REC: Record<Recommendation, { label: string; cls: string; action: boolean }> = {
  scale: { label: 'Scale', cls: 'bg-emerald-500/15 text-emerald-400', action: true },
  maintain: { label: 'Maintain', cls: 'bg-white/5 text-muted', action: false },
  optimize: { label: 'Optimize', cls: 'bg-amber-500/15 text-amber-400', action: true },
  improve_evidence: { label: 'Improve evidence', cls: 'bg-sky-500/15 text-sky-400', action: true },
  require_approval: { label: 'Require approval', cls: 'bg-amber-500/15 text-amber-400', action: true },
  investigate: { label: 'Investigate', cls: 'bg-orange-500/15 text-orange-400', action: true },
  pause: { label: 'Pause', cls: 'bg-rose-500/15 text-rose-400', action: true },
  retire: { label: 'Retire', cls: 'bg-rose-500/15 text-rose-400', action: true },
};

function RecBadge({ rec }: { rec: Recommendation }) {
  const r = REC[rec] ?? REC.maintain;
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${r.cls}`}>{r.label}</span>;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default async function OverviewPage({ searchParams }: { searchParams: { team?: string } }) {
  const { from, to } = defaultRange();
  const team = searchParams.team || undefined;
  const api = apiClient();

  // Spend + risk honor the team filter; agent economics (LARI rollup) is
  // portfolio-wide by design (the recommendation must match /v1/agents/:id/lari,
  // which is not team-scoped), so a selected team only narrows the spend section.
  const [spend, economics, teams] = await Promise.all([
    fetchData(
      api.GET('/v1/analytics/spend', { params: { query: { from, to, team } } }),
      [],
    ) as Promise<unknown> as Promise<SpendRow[]>,
    fetchData(
      api.GET('/v1/analytics/agent-economics', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<AgentEconomicsRow[]>,
    fetchData(
      api.GET('/v1/teams', { params: { query: { limit: '200', offset: '0' } } }),
      [],
    ) as Promise<unknown> as Promise<Team[]>,
  ]);

  const totalCost = spend.reduce((s, r) => s + Number(r.cost_usd), 0);
  const totalCalls = spend.reduce((s, r) => s + Number(r.calls), 0);
  const blocked = spend.reduce((s, r) => s + Number(r.blocked_calls), 0);
  const chart = spend.map((r) => ({ day: r.day, cost_usd: Number(r.cost_usd) }));

  const netRoi = economics.reduce((s, r) => s + Number(r.risk_adjusted_roi), 0);
  const actions = economics.filter((r) => REC[r.recommendation]?.action);

  const teamLabel = team ? teams.find((t) => t.id === team)?.name ?? team : 'all teams';

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${teamLabel} · ${from} → ${to}`}
        actions={
          teams.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/"
                className={`rounded px-3 py-1.5 text-sm ${
                  !team ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                All teams
              </Link>
              {teams.map((t) => (
                <Link
                  key={t.id}
                  href={`/?team=${encodeURIComponent(t.id)}`}
                  className={`rounded px-3 py-1.5 text-sm ${
                    team === t.id ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                  }`}
                >
                  {t.name}
                </Link>
              ))}
            </div>
          ) : undefined
        }
      />

      <div className="mb-6 grid grid-cols-4 gap-4">
        <Stat label="Total spend" value={usd(totalCost)} sub={team ? teamLabel : undefined} />
        <Stat label="Calls" value={num(totalCalls)} />
        <Stat label="Blocked calls" value={num(blocked)} />
        <Stat
          label="Net risk-adjusted ROI"
          value={usd(netRoi)}
          sub={`${num(economics.length)} agents · portfolio-wide`}
        />
      </div>

      <Card title="Daily spend (USD)">
        <LineChartClient data={chart} xKey="day" yKey="cost_usd" />
      </Card>

      <Card title="Recommended actions">
        {actions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            No action items — every tracked agent is recommended to maintain.
          </p>
        ) : (
          <DataTable
            columns={[
              { key: 'agent', label: 'Agent' },
              { key: 'rec', label: 'Recommendation' },
              { key: 'roi', label: 'Risk-adj ROI', align: 'right' },
              { key: 'lari', label: 'LARI', align: 'right' },
              { key: 'conf', label: 'Confidence', align: 'right' },
            ]}
            rows={actions.map((r) => ({
              agent: (
                <Link className="text-sky-600 hover:underline" href={`/agents/${encodeURIComponent(r.agentId)}`}>
                  {r.agentId}
                </Link>
              ),
              rec: <RecBadge rec={r.recommendation} />,
              roi: usd(r.risk_adjusted_roi),
              lari: Number(r.lari).toFixed(2),
              conf: `${Math.round(Number(r.confidenceScore))}/100`,
            }))}
          />
        )}
      </Card>

      <Card title="Agent economics">
        <DataTable
          columns={[
            { key: 'agent', label: 'Agent' },
            { key: 'cost', label: 'Cost', align: 'right' },
            { key: 'value', label: 'Value', align: 'right' },
            { key: 'roi', label: 'Risk-adj ROI', align: 'right' },
            { key: 'lari', label: 'LARI', align: 'right' },
            { key: 'conf', label: 'Confidence', align: 'right' },
            { key: 'rec', label: 'Recommendation' },
          ]}
          rows={economics.map((r) => ({
            agent: (
              <Link className="text-sky-600 hover:underline" href={`/agents/${encodeURIComponent(r.agentId)}`}>
                {r.agentId}
              </Link>
            ),
            cost: usd(r.cost_usd),
            value: usd(r.value_usd),
            roi: usd(r.risk_adjusted_roi),
            lari: Number(r.lari).toFixed(2),
            conf: `${Math.round(Number(r.confidenceScore))}/100`,
            rec: <RecBadge rec={r.recommendation} />,
          }))}
        />
      </Card>
    </>
  );
}

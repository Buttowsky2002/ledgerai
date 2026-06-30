import Link from 'next/link';
import { Suspense } from 'react';
import { AreaChartClient, Sparkline } from '../components/charts';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { OverviewAiSourcesPanel } from '../components/overview/OverviewAiSourcesPanel';
import { ExecutiveReportExport } from '../components/overview/ExecutiveReportExport';
import { LariRecommendationsPanel } from '../components/lari/LariRecommendationsPanel';
import { Badge, BadgeTone, Card, DataTable, PageHeader, Stat, num, usd } from '../components/ui';
import { apiClient, fetchData } from '../lib/api';
import { parseRange } from '../lib/date-range';

export const dynamic = 'force-dynamic';

type SpendRow = {
  day: string;
  cost_usd: number | string;
  calls: string;
  tokens: string;
  blocked_calls: string;
  error_calls: string;
};

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

type AllocationRow = { key: string; cost_usd: number | string; calls: string };
type PlatformRow = { platform: string; cost_usd: number | string; calls: string };
type ModelRow = { provider: string; model: string; cost_usd: number | string; calls: string };

// Presentation + triage metadata for each LARI recommendation. `priority` orders
// the action queue (0 = most urgent); `action` decides whether it surfaces there;
// `hint` is a content-free rationale for why the engine flagged it.
const REC: Record<
  Recommendation,
  { label: string; tone: BadgeTone; action: boolean; priority: number; hint: string }
> = {
  pause: { label: 'Pause', tone: 'neg', action: true, priority: 0, hint: 'Negative net return — halt spend' },
  retire: { label: 'Retire', tone: 'neg', action: true, priority: 0, hint: 'No attributable value — decommission' },
  investigate: { label: 'Investigate', tone: 'warn', action: true, priority: 1, hint: 'Anomalous cost or risk signal' },
  require_approval: { label: 'Require approval', tone: 'warn', action: true, priority: 1, hint: 'Governance gate before scaling' },
  optimize: { label: 'Optimize', tone: 'warn', action: true, priority: 2, hint: 'High cost relative to value' },
  improve_evidence: { label: 'Improve evidence', tone: 'info', action: true, priority: 3, hint: 'Attribution confidence below threshold' },
  scale: { label: 'Scale', tone: 'pos', action: true, priority: 4, hint: 'Strong return — expand deployment' },
  maintain: { label: 'Maintain', tone: 'neutral', action: false, priority: 5, hint: 'Healthy — no action needed' },
};

const BAR_BG: Record<BadgeTone, string> = {
  neg: 'bg-neg',
  warn: 'bg-warn',
  info: 'bg-accent',
  pos: 'bg-pos',
  neutral: 'bg-edge',
};

const meta = (rec: Recommendation) => REC[rec] ?? REC.maintain;
const roiTone = (v: number) => (v > 0 ? 'text-pos' : v < 0 ? 'text-neg' : 'text-gray-200');
const fmtLari = (v: number) => `${num(Math.round(Number(v)))}×`;

// Inline confidence meter (0–100): a numeric read plus a slim track.
function ConfMeter({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const tone = pct >= 67 ? 'bg-pos' : pct >= 34 ? 'bg-warn' : 'bg-neg';
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="num text-gray-300">{pct}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-edge">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; source?: string };
}) {
  const { from, to } = parseRange(searchParams);
  const source = searchParams.source || undefined;
  const rangeParams = { from, to, source };
  const api = apiClient();

  const [spend, economics, costByUser, platformSpend, modelMix] = await Promise.all([
    fetchData(
      api.GET('/v1/analytics/spend', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<SpendRow[]>,
    fetchData(
      api.GET('/v1/analytics/agent-economics', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<AgentEconomicsRow[]>,
    fetchData(
      api.GET('/v1/analytics/allocation', { params: { query: { dimension: 'user', from, to } } }),
      [],
    ) as Promise<unknown> as Promise<AllocationRow[]>,
    fetchData(
      api.GET('/v1/analytics/platform-spend', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<PlatformRow[]>,
    fetchData(
      api.GET('/v1/analytics/model-mix', { params: { query: { from, to } } }),
      [],
    ) as Promise<unknown> as Promise<ModelRow[]>,
  ]);

  const platforms = platformSpend
    .map((r) => ({
      platform: r.platform || '(unknown)',
      cost_usd: Number(r.cost_usd),
      calls: Number(r.calls),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  const models = modelMix.map((r) => ({
    provider: r.provider,
    model: r.model,
    cost_usd: Number(r.cost_usd),
    calls: Number(r.calls),
  }));

  const totalCost = spend.reduce((s, r) => s + Number(r.cost_usd), 0);
  const totalCalls = spend.reduce((s, r) => s + Number(r.calls), 0);
  const blocked = spend.reduce((s, r) => s + Number(r.blocked_calls), 0);
  const chart = spend.map((r) => ({ day: String(r.day).slice(5), cost_usd: Number(r.cost_usd) }));

  const netRoi = economics.reduce((s, r) => s + Number(r.risk_adjusted_roi), 0);
  const totalValue = economics.reduce((s, r) => s + Number(r.value_usd), 0);

  // Action queue: actionable recommendations, most urgent first, ties broken by
  // risk-adjusted ROI magnitude (biggest dollars first).
  const actions = economics
    .filter((r) => meta(r.recommendation).action)
    .sort((a, b) => {
      const p = meta(a.recommendation).priority - meta(b.recommendation).priority;
      return p !== 0 ? p : Math.abs(b.risk_adjusted_roi) - Math.abs(a.risk_adjusted_roi);
    });

  return (
    <>
      <PageHeader
        eyebrow="FinOps control plane"
        title="Overview"
        subtitle={`${from} → ${to}`}
        actions={
          <div className="flex flex-col items-end gap-2">
            <ExecutiveReportExport from={from} to={to} />
            <DateRangeFilter basePath="/" from={from} to={to} extraParams={rangeParams} />
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Total spend"
          value={usd(totalCost)}
          accent
          sub={`${num(totalCalls)} calls`}
          chart={chart.length > 1 ? <Sparkline data={chart} yKey="cost_usd" /> : undefined}
        />
        <Stat
          label="Net risk-adjusted ROI"
          value={usd(netRoi)}
          tone={netRoi >= 0 ? 'pos' : 'neg'}
          sub={`on ${usd(totalValue)} attributed value`}
        />
        <Stat
          label="Action items"
          value={num(actions.length)}
          tone={actions.length > 0 ? 'warn' : 'pos'}
          sub={`${num(economics.length)} agents tracked`}
        />
        <Stat
          label="Blocked calls"
          value={num(blocked)}
          tone={blocked > 0 ? 'warn' : 'default'}
          sub="policy + DLP enforcement"
        />
      </div>

      <Card title="Daily spend" subtitle="USD">
        <AreaChartClient data={chart} xKey="day" yKey="cost_usd" />
      </Card>

      <Suspense
        fallback={
          <Card title="AI sources & models">
            <p className="py-8 text-center text-sm text-muted">Loading sources…</p>
          </Card>
        }
      >
        <OverviewAiSourcesPanel
          platforms={platforms}
          modelMix={models}
          from={from}
          to={to}
          initialSource={source}
        />
      </Suspense>

      <Card title="Cost by user" subtitle="Includes API-synced and gateway spend">
        <DataTable
          columns={[
            { key: 'user', label: 'User' },
            { key: 'cost', label: 'Spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
          ]}
          rows={costByUser.map((r) => ({
            user: r.key === 'Unassigned' ? (
              <span className="text-warn">{r.key}</span>
            ) : (
              r.key
            ),
            cost: usd(Number(r.cost_usd)),
            calls: num(r.calls),
          }))}
        />
      </Card>

      <Card
        title="Recommended actions"
        subtitle="LARI engine · portfolio-wide"
        actions={<Badge tone={actions.length > 0 ? 'warn' : 'pos'}>{num(actions.length)} flagged</Badge>}
      >
        {actions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No action items — every tracked agent is recommended to maintain.
          </p>
        ) : (
          <div className="divide-y divide-edge/60">
            {actions.map((r) => {
              const m = meta(r.recommendation);
              return (
                <div key={r.agentId} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                  <span className={`h-9 w-1 shrink-0 rounded-full ${BAR_BG[m.tone]}`} />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/agents/${encodeURIComponent(r.agentId)}`}
                      className="num text-sm font-medium text-gray-100 hover:text-accent"
                    >
                      {r.agentId}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted">{m.hint}</div>
                  </div>
                  <Badge tone={m.tone} dot>
                    {m.label}
                  </Badge>
                  <div className="w-32 text-right">
                    <div className={`num text-sm font-medium ${roiTone(r.risk_adjusted_roi)}`}>
                      {usd(r.risk_adjusted_roi)}
                    </div>
                    <div className="text-[11px] uppercase tracking-wide text-muted">risk-adj ROI</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <LariRecommendationsPanel from={from} to={to} compact />

      <Card title="Agent economics" subtitle="Per-agent cost, value, and LARI">
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
          rows={economics.map((r) => {
            const m = meta(r.recommendation);
            return {
              agent: (
                <Link
                  className="num text-gray-100 hover:text-accent"
                  href={`/agents/${encodeURIComponent(r.agentId)}`}
                >
                  {r.agentId}
                </Link>
              ),
              cost: usd(r.cost_usd),
              value: usd(r.value_usd),
              roi: <span className={roiTone(r.risk_adjusted_roi)}>{usd(r.risk_adjusted_roi)}</span>,
              lari: fmtLari(r.lari),
              conf: <ConfMeter score={r.confidenceScore} />,
              rec: (
                <Badge tone={m.tone} dot>
                  {m.label}
                </Badge>
              ),
            };
          })}
        />
      </Card>
    </>
  );
}

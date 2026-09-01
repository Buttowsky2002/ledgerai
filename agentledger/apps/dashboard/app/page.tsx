import Link from 'next/link';
import { Suspense } from 'react';
import { AreaChartClient, Sparkline } from '../components/charts';
import { OverviewAiSourcesPanel } from '../components/overview/OverviewAiSourcesPanel';
import type { CursorSpendSummary } from '../components/overview/CursorPlatformDetail';
import { CostByUserPanel } from '../components/overview/CostByUserPanel';
import { FixedOverheadPanel, type VendorBillingData } from '../components/overview/FixedOverheadPanel';
import { OverviewSeatSubscriptions } from '../components/overview/OverviewSeatSubscriptions';
import { ExecutiveReportExport } from '../components/overview/ExecutiveReportExport';
import { OverviewLiveRefresh } from '../components/overview/OverviewLiveRefresh';
import { LariRecommendationsPanel } from '../components/lari/LariRecommendationsPanel';
import { ProductWorthPanel } from '../components/lari/ProductWorthPanel';
import { Badge, BadgeTone, Card, DataTable, PageHeader, Stat, num, usd } from '../components/ui';
import { DateRangePicker } from '../components/DateRangePicker';
import { apiClient, fetchData, proxyApi } from '../lib/api';
import { fetchDataBounds } from '../lib/data-bounds';
import { env } from '../lib/env';
import { seatUsdByVendor } from '../lib/platform-billing';
import { formatSignedUsd } from '../lib/seat-price-delta';

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  team: string;
};

export const dynamic = 'force-dynamic';

function liveRefreshIntervalMs(): number {
  const raw = env('BADGERIQ_DASHBOARD_LIVE_REFRESH_MS');
  if (!raw) {
    return 30_000;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

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

type AllocationRow = {
  key: string;
  cost_usd: number | string;
  calls: string;
  tokens?: number | string;
  portal_import_usd?: number | string;
  connector_usd?: number | string;
  metered_usd?: number | string;
  seat_usd?: number | string;
  cursor_on_demand_usd?: number | string;
  cursor_included_usd?: number | string;
  spend_trend?: 'up' | 'down' | 'flat' | 'insufficient';
  trend_change_pct?: number;
  trend_change_usd?: number;
};
type PlatformRow = { platform: string; cost_usd: number | string; calls: string };
type ModelRow = { provider: string; model: string; cost_usd: number | string; calls: string };

// Presentation + triage metadata for each LARI recommendation. `priority` orders
// the action queue (0 = most urgent); `action` decides whether it surfaces there;
// `hint` is a content-free rationale for why the engine flagged it.
const REC: Record<
  Recommendation,
  { label: string; tone: BadgeTone; action: boolean; priority: number; hint: string }
> = {
  pause: {
    label: 'Pause',
    tone: 'neg',
    action: true,
    priority: 0,
    hint: 'Negative net return — halt spend',
  },
  retire: {
    label: 'Retire',
    tone: 'neg',
    action: true,
    priority: 0,
    hint: 'No attributable value — decommission',
  },
  investigate: {
    label: 'Investigate',
    tone: 'warn',
    action: true,
    priority: 1,
    hint: 'Anomalous cost or risk signal',
  },
  require_approval: {
    label: 'Require approval',
    tone: 'warn',
    action: true,
    priority: 1,
    hint: 'Governance gate before scaling',
  },
  optimize: {
    label: 'Optimize',
    tone: 'warn',
    action: true,
    priority: 2,
    hint: 'High cost relative to value',
  },
  improve_evidence: {
    label: 'Improve evidence',
    tone: 'info',
    action: true,
    priority: 3,
    hint: 'Attribution confidence below threshold',
  },
  scale: {
    label: 'Scale',
    tone: 'pos',
    action: true,
    priority: 4,
    hint: 'Strong return — expand deployment',
  },
  maintain: {
    label: 'Maintain',
    tone: 'neutral',
    action: false,
    priority: 5,
    hint: 'Healthy — no action needed',
  },
};

const BAR_BG: Record<BadgeTone, string> = {
  neg: 'bg-neg',
  warn: 'bg-warn',
  info: 'bg-accent',
  pos: 'bg-pos',
  neutral: 'bg-edge',
};

const meta = (rec: Recommendation) => REC[rec] ?? REC.maintain;
const roiTone = (v: number) => (v > 0 ? 'text-pos' : v < 0 ? 'text-neg' : 'text-muted');
const fmtLari = (v: number) => `${num(Math.round(Number(v)))}×`;

// Inline confidence meter (0–100): a numeric read plus a slim track.
function ConfMeter({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const tone = pct >= 67 ? 'bg-pos' : pct >= 34 ? 'bg-warn' : 'bg-neg';
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="num text-muted">{pct}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-edge">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: {
    from?: string;
    to?: string;
    source?: string;
    vendor?: string;
    range?: string;
    aiView?: string;
  };
}) {
  const source = searchParams.source || undefined;
  const api = apiClient();

  const dataBounds = await fetchDataBounds();
  const { from, to, isAllTime } = resolvePageRange(searchParams, dataBounds);

  type FixedCostVendorRow = { vendor?: string | null; cost_usd?: number | string | null };

  const [
    spend,
    economics,
    costByUser,
    platformSpend,
    modelMix,
    fixedCostRows,
    usersRes,
    vendorBillingRes,
  ] = await Promise.all([
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
    (async () => {
      const qs = new URLSearchParams({ from, to }).toString();
      const res = await proxyApi(`/v1/fixed-costs?${qs}`);
      return res.ok && Array.isArray(res.data) ? (res.data as FixedCostVendorRow[]) : [];
    })(),
    (async () => {
      const qs = new URLSearchParams({ from, to }).toString();
      const res = await proxyApi(`/v1/analytics/users?${qs}`);
      return res.ok && res.data && typeof res.data === 'object'
        ? res.data
        : { users: [], vendors: [] };
    })(),
    (async () => {
      const qs = new URLSearchParams({ from, to }).toString();
      const res = await proxyApi(`/v1/analytics/vendor-billing?${qs}`);
      return res.ok && res.data && typeof res.data === 'object'
        ? res.data
        : { vendors: [], total_cost_of_ai: 0 };
    })(),
  ]);

  // Seat / subscription overhead per vendor — lets the source list badge each
  // platform from real billing data instead of a per-provider assumption.
  const seatUsdByVendorMap = seatUsdByVendor(fixedCostRows);

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

  const hasCursorPlatform = platforms.some((p) => p.platform.toLowerCase() === 'cursor');
  // Always fetch cursor-spend so included-only tenants (no metered overage) still
  // surface in the AI sources panel.
  const cursorRes = await proxyApi(
    `/v1/analytics/cursor-spend?${new URLSearchParams({ from, to })}`,
  );
  const cursorSpendError = !cursorRes.ok;
  const cursorSpend: CursorSpendSummary | null =
    cursorRes.ok && cursorRes.data && typeof cursorRes.data === 'object'
      ? (cursorRes.data as CursorSpendSummary)
      : null;

  if (
    cursorSpend &&
    !hasCursorPlatform &&
    (cursorSpend.totalCalls > 0 ||
      cursorSpend.usageValueUsd > 0 ||
      cursorSpend.billedUsd > 0 ||
      (cursorSpend.linesAccepted ?? 0) > 0)
  ) {
    platforms.push({
      platform: 'cursor',
      cost_usd: cursorSpend.billedUsd ?? cursorSpend.meteredOverageUsd ?? 0,
      calls: cursorSpend.onDemandCalls ?? 0,
    });
    platforms.sort((a, b) => b.cost_usd - a.cost_usd);
  }

  const meteredCost = spend.reduce((s, r) => s + Number(r.cost_usd), 0);
  const totalCalls = spend.reduce((s, r) => s + Number(r.calls), 0);
  const vendorBilling: VendorBillingData =
    vendorBillingRes.ok && vendorBillingRes.data && typeof vendorBillingRes.data === 'object'
      ? (vendorBillingRes.data as VendorBillingData)
      : { vendors: [], total_cost_of_ai: 0 };
  const orgVendorsForTotals = vendorBilling.vendors ?? [];
  const fixedOverhead = orgVendorsForTotals.reduce((s, v) => s + Number(v.seat_usd ?? 0), 0);
  const totalSeats = orgVendorsForTotals.reduce((s, v) => s + (v.seats != null && v.seats > 0 ? v.seats : 0), 0);
  const seatChangeUsd = vendorBilling.seat_change_usd ?? 0;
  const attributableCost = meteredCost;
  const totalCostOfAi = meteredCost + fixedOverhead;
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
        subtitle={
          <DateRangePicker
            basePath="/"
            from={from}
            to={to}
            earliestDay={dataBounds.earliest_day}
            latestDay={dataBounds.latest_day}
            isAllTime={isAllTime}
            extraParams={source ? { source } : undefined}
          />
        }
        actions={
          <div className="flex flex-wrap items-center gap-4">
            <OverviewLiveRefresh intervalMs={liveRefreshIntervalMs()} />
            <Suspense fallback={<div className="text-sm text-muted">Export report…</div>}>
              <ExecutiveReportExport from={from} to={to} bounds={dataBounds} />
            </Suspense>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Total cost of AI"
          value={usd(totalCostOfAi)}
          accent
          sub={
            <>
              {usd(attributableCost)} metered · {usd(fixedOverhead)} fixed
              <span className="mt-0.5 block">{num(totalCalls)} calls</span>
            </>
          }
          chart={chart.length > 1 ? <Sparkline data={chart} yKey="cost_usd" /> : undefined}
        />
        <Stat
          label="Seat subscriptions"
          value={usd(fixedOverhead)}
          tone="warn"
          sub={
            <>
              {totalSeats > 0 ? `${num(totalSeats)} seats · monthly` : 'monthly seat licenses'}
              {seatChangeUsd !== 0 && (
                <span
                  className={`mt-0.5 block ${seatChangeUsd > 0 ? 'text-warn' : 'text-pos'}`}
                >
                  {formatSignedUsd(seatChangeUsd)} from seat changes
                </span>
              )}
            </>
          }
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

      <OverviewSeatSubscriptions vendors={orgVendorsForTotals} seatChangeUsd={seatChangeUsd} />

      <FixedOverheadPanel from={from} to={to} vendorBilling={vendorBilling} />

      <Suspense
        fallback={
          <Card title="Product worth">
            <p className="py-8 text-center text-sm text-muted">Loading product worth…</p>
          </Card>
        }
      >
        <ProductWorthPanel from={from} to={to} />
      </Suspense>

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
          from={from}
          to={to}
          users={
            ((usersRes as { users?: UserRow[] }).users ?? []) as Parameters<
              typeof OverviewAiSourcesPanel
            >[0]['users']
          }
          models={models}
          orgVendors={orgVendorsForTotals}
          cursorSpend={cursorSpend}
        />
      </Suspense>

      <Suspense
        fallback={
          <Card title="Cost by user">
            <p className="py-8 text-center text-sm text-muted">Loading user spend…</p>
          </Card>
        }
      >
        <CostByUserPanel initialRows={costByUser} initialFrom={from} initialTo={to} />
      </Suspense>

      <Card
        title="Recommended actions"
        subtitle="LARI engine · portfolio-wide"
        actions={
          <Badge tone={actions.length > 0 ? 'warn' : 'pos'}>{num(actions.length)} flagged</Badge>
        }
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
                    <div className="text-[11px] uppercase tracking-wide text-muted">
                      risk-adj ROI
                    </div>
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

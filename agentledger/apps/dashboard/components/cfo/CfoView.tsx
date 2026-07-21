'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DateRangePicker } from '@/components/DateRangePicker';
import { BarChartClient } from '@/components/charts';
import { LariRecommendationsPanel } from '@/components/lari/LariRecommendationsPanel';
import { Card, DataTable, PageHeader, Stat, usd } from '@/components/ui';
import { ForecastHorizonLinks, forecastContextLabel } from '@/components/ForecastHorizonLinks';
import { CostPerOutcomeStat } from '@/components/cfo/CostPerOutcomeStat';
import { fetchCfoView, fetchUserValue } from '@/lib/api/lari';
import { rangeHref, type DateBounds } from '@/lib/date-range';
import { forecastHorizonLabel } from '@/lib/forecast-horizon';
import type { CostBasisMode, CfoViewResponse, UserValueResponse } from '@/types/lari';

const BASIS_OPTIONS: { value: CostBasisMode; label: string }[] = [
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'computed', label: 'Computed' },
  { value: 'metered', label: 'Metered' },
];

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const basisLabel = (b: CostBasisMode) => BASIS_OPTIONS.find((o) => o.value === b)?.label ?? b;

function SkeletonStat() {
  return (
    <div className="animate-pulse rounded-xl border border-edge bg-panel p-5">
      <div className="mb-2 h-3 w-24 rounded bg-edge" />
      <div className="h-7 w-32 rounded bg-edge" />
    </div>
  );
}

function UtilizationMeter({ score }: { score: number }) {
  const tone = score >= 60 ? 'bg-pos' : score >= 30 ? 'bg-warn' : 'bg-neg';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-edge">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted">{score}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'low_use' | 'inactive' }) {
  const label = status === 'low_use' ? 'low use' : status;
  const tone =
    status === 'active' ? 'text-pos border-pos/40 bg-pos/10' : status === 'low_use'
      ? 'text-warn border-warn/40 bg-warn/10'
      : 'text-neg border-neg/40 bg-neg/10';
  return (
    <span className={`rounded border px-2 py-0.5 text-xs capitalize ${tone}`}>{label}</span>
  );
}

function PlatformUtilizationCard({
  from,
  to,
  data,
  loading,
}: {
  from: string;
  to: string;
  data: UserValueResponse | null;
  loading: boolean;
}) {
  const empty =
    !loading &&
    data &&
    (data.mode === 'team'
      ? data.aggregates.provisionedSeats === 0 && data.aggregates.meteredUsers === 0
      : data.users.length === 0);

  const showMeteredProxy =
    !loading &&
    data?.mode === 'team' &&
    data.aggregates.provisionedSeats === 0 &&
    data.aggregates.meteredUsers > 0;

  return (
    <Card title="Platform utilization" subtitle={`License & usage proxy · ${from} → ${to}`}>
      {loading ? (
        <div className="animate-pulse py-8 text-center text-sm text-muted">Loading utilization…</div>
      ) : empty ? (
        <p className="py-8 text-center text-sm text-muted">
          Connect a provider import or assign seats to populate utilization.
        </p>
      ) : showMeteredProxy ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Active users"
            value={String(data.aggregates.activeMeteredUsers)}
            sub={`of ${data.aggregates.meteredUsers} with metered usage`}
          />
          <Stat
            label="Low use"
            value={String(data.aggregates.lowUseMeteredUsers)}
            sub={`${data.aggregates.inactiveMeteredUsers} inactive`}
          />
          <Stat
            label="Metered spend"
            value={usd(data.aggregates.meteredSpendUsd)}
            sub="observed in window"
          />
          <Stat
            label="Seat licenses"
            value="—"
            sub="assign in Settings → Plans to track seats"
          />
        </div>
      ) : data?.mode === 'team' ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Active seats"
            value={String(data.aggregates.activeSeats)}
            sub={`of ${data.aggregates.provisionedSeats} provisioned`}
          />
          <Stat
            label="Inactive seats"
            value={String(data.aggregates.inactiveSeats)}
            sub={`${data.aggregates.lowUseSeats} low use`}
          />
          <Stat
            label="Reclaimable / mo"
            value={usd(data.aggregates.reclaimableMonthlyUsd)}
            sub="unused license spend"
          />
          <Stat
            label="Plans flagged"
            value={String(data.aggregates.byPlan.length)}
            sub="with inactive assignments"
          />
        </div>
      ) : data?.mode === 'individual' ? (
        <DataTable
          columns={[
            { key: 'user', label: 'User' },
            { key: 'providers', label: 'Providers' },
            { key: 'calls', label: 'Calls', align: 'right' },
            { key: 'days', label: 'Active days', align: 'right' },
            { key: 'util', label: 'Utilization' },
            { key: 'seat', label: 'Seat $/mo', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={data.users.map((u) => ({
            user: u.displayName,
            providers: u.providers.join(', ') || '—',
            calls: String(u.calls),
            days: String(u.activeDays),
            util: <UtilizationMeter score={u.utilizationScore} />,
            seat: u.seatMonthlyCostUsd > 0 ? usd(u.seatMonthlyCostUsd) : '—',
            status: <StatusBadge status={u.status} />,
          }))}
        />
      ) : null}
    </Card>
  );
}

export function CfoView({
  from,
  to,
  isAllTime,
  dataBounds,
  forecastDays,
  costBasis,
}: {
  from: string;
  to: string;
  isAllTime: boolean;
  dataBounds: DateBounds;
  forecastDays: number;
  costBasis: CostBasisMode;
}) {
  const [data, setData] = useState<CfoViewResponse | null>(null);
  const [userValue, setUserValue] = useState<UserValueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [utilLoading, setUtilLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchCfoView({
      startDate: from,
      endDate: to,
      costBasis,
      forecastDays,
    })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(!res);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, forecastDays, costBasis]);

  useEffect(() => {
    let cancelled = false;
    setUtilLoading(true);
    fetchUserValue({ from, to })
      .then((res) => {
        if (!cancelled) setUserValue(res);
      })
      .finally(() => {
        if (!cancelled) setUtilLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const outcomeCount = data?.outcomeBreakdown.reduce((s, r) => s + r.outcomes, 0) ?? 0;
  const noOutcomesButSpend =
    !loading && !error && data && outcomeCount === 0 && data.summary.fullyLoadedCost > 0;

  const empty =
    !loading &&
    !error &&
    data &&
    data.outcomeBreakdown.length === 0 &&
    data.summary.businessValue === 0 &&
    data.summary.fullyLoadedCost === 0;

  return (
    <>
      <PageHeader
        title="CFO view"
        subtitle={
          <DateRangePicker
            basePath="/cfo"
            from={from}
            to={to}
            earliestDay={dataBounds.earliest_day}
            latestDay={dataBounds.latest_day}
            isAllTime={isAllTime}
            extraParams={{ horizon: String(forecastDays), basis: costBasis }}
            label="Run-rate window"
          />
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <ForecastHorizonLinks
              basePath="/cfo"
              from={from}
              to={to}
              forecastDays={forecastDays}
              extraParams={{ basis: costBasis }}
            />
            <div className="flex gap-2">
              {BASIS_OPTIONS.map((opt) => (
                <Link
                  key={opt.value}
                  href={rangeHref('/cfo', from, to, { horizon: String(forecastDays), basis: opt.value })}
                  className={`rounded px-3 py-1.5 text-sm ${
                    opt.value === costBasis ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                  }`}
                >
                  {opt.label}
                </Link>
              ))}
            </div>
          </div>
        }
      />

      <p className="mb-4 text-xs text-muted">
        {data
          ? forecastContextLabel(data.summary.forecastDays, data.summary.observedPeriodDays)
          : `${forecastHorizonLabel(forecastDays)} project spend · ${basisLabel(costBasis)} basis · ${from} → ${to}`}
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load CFO metrics. Check API connectivity and try again.
        </p>
      )}

      <div className="mb-2 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {loading ? (
          <>
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
          </>
        ) : data ? (
          <>
            <Stat
              label="Risk-adjusted ROI"
              value={usd(data.summary.riskAdjustedRoi)}
              sub={`observed window · nominal ${usd(data.summary.nominalRoi)}`}
            />
            <Stat
              label="Business value"
              value={usd(data.summary.businessValue)}
              sub={`ROI margin ${pct(data.summary.roiMargin)}`}
            />
            <Stat
              label="Projected spend"
              value={usd(data.summary.fullyLoadedCost)}
              sub={`${forecastHorizonLabel(data.summary.forecastDays)} · observed ${usd(data.summary.observedFullyLoadedCost)}`}
            />
            <Stat
              label="Projected token / API"
              value={usd(data.costProvenance.stack.tokenUsageUsd)}
              sub={`${basisLabel(data.summary.costBasis)} per-token or metered`}
            />
            <CostPerOutcomeStat summary={data.summary} outcomeCount={outcomeCount} />
            <Stat
              label="Fixed cost (seats)"
              value={usd(data.costProvenance.stack.fixedCostUsd)}
              sub="from fixed_costs licenses & subscriptions"
            />
          </>
        ) : null}
      </div>

      {!loading && data && (
        <p className="mb-4 rounded-lg border border-edge bg-panel/50 px-4 py-2 text-xs text-muted">
          Projected stack ({forecastHorizonLabel(data.summary.forecastDays)}): tokens{' '}
          {usd(data.costProvenance.stack.tokenUsageUsd)} ({basisLabel(data.summary.costBasis)}) · fixed cost{' '}
          {usd(data.costProvenance.stack.fixedCostUsd)} · coding agents {usd(data.costProvenance.stack.codingAgentUsd)} ·
          Copilot {usd(data.costProvenance.stack.copilotUsd)} · overhead{' '}
          {usd(data.costProvenance.stack.qaEvalOverheadUsd)} · computed{' '}
          {usd(data.costProvenance.computedCostUsd)} · metered {usd(data.costProvenance.meteredCostUsd)} · variance{' '}
          {data.costProvenance.variancePct.toFixed(1)}% · coverage{' '}
          {data.costProvenance.meteredCoveragePct.toFixed(0)}%
        </p>
      )}

      {!loading && data && data.warnings.length > 0 && (
        <div className="mb-4 space-y-2">
          {data.warnings.map((w) => (
            <p key={w} className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
              {w}
            </p>
          ))}
        </div>
      )}

      <p className="mb-6 text-xs text-muted">
        ROI and cost per outcome use observed spend in the selected window. Projected spend extrapolates that
        run rate to the forecast horizon (e.g. 1 year). Token costs use reconciled connector/portal billing;
        seat licenses use fixed_costs entries.
      </p>

      <div className="mb-6">
        <LariRecommendationsPanel from={from} to={to} />
      </div>

      <div className="mb-6">
        <PlatformUtilizationCard from={from} to={to} data={userValue} loading={utilLoading} />
      </div>

      {noOutcomesButSpend && (
        <Card title="Spend without attributed outcomes">
          <p className="text-sm text-muted">
            {usd(data!.summary.fullyLoadedCost)} projected spend ({forecastHorizonLabel(data!.summary.forecastDays)})
            with tokens, fixed seat licenses, and meter/connector imports but no linked outcomes. Cost per outcome
            requires outcome mappings — LARI below flags seat waste and model right-sizing from meter data.
          </p>
        </Card>
      )}

      {empty ? (
        <Card title="Spend without attributed outcomes">
          <p className="text-sm text-muted">
            {data && data.summary.fullyLoadedCost > 0
              ? `You have ${usd(data.summary.fullyLoadedCost)} in projected spend but no linked outcomes. Connect outcome sources or review LARI recommendations for seat and model optimization.`
              : 'No LARI outcomes found for this period. Connect providers, import usage, or create outcome mappings.'}
          </p>
        </Card>
      ) : (
        <>
          <Card title="Risk-adjusted ROI by month (USD)">
            {loading ? (
              <div className="flex h-[280px] animate-pulse items-center justify-center text-sm text-muted">
                Loading chart…
              </div>
            ) : (
              <BarChartClient
                data={(data?.monthly ?? []).map((m) => ({ month: m.month, roi: m.riskAdjustedRoi }))}
                xKey="month"
                yKey="roi"
              />
            )}
          </Card>
          <Card title="ROI by outcome type">
            {loading ? (
              <div className="animate-pulse py-8 text-center text-sm text-muted">Loading table…</div>
            ) : (
              <DataTable
                columns={[
                  { key: 'type', label: 'Outcome type' },
                  { key: 'outcomes', label: 'Outcomes', align: 'right' },
                  { key: 'value', label: 'Value', align: 'right' },
                  { key: 'cost', label: 'Fully-loaded cost', align: 'right' },
                  { key: 'costPerOutcome', label: 'Cost / outcome', align: 'right' },
                  { key: 'nominal', label: 'Nominal ROI', align: 'right' },
                  { key: 'riskAdj', label: 'Risk-adj ROI', align: 'right' },
                  { key: 'conf', label: 'Avg conf', align: 'right' },
                ]}
                rows={(data?.outcomeBreakdown ?? []).map((r) => ({
                  type: r.outcomeType,
                  outcomes: String(r.outcomes),
                  value: usd(r.businessValue),
                  cost: usd(r.fullyLoadedCost),
                  costPerOutcome: usd(r.costPerOutcome),
                  nominal: usd(r.nominalRoi),
                  riskAdj: usd(r.riskAdjustedRoi),
                  conf: r.avgConfidence.toFixed(2),
                }))}
              />
            )}
          </Card>
        </>
      )}
    </>
  );
}

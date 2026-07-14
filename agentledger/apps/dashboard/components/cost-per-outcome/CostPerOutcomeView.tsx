'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DateRangePicker } from '@/components/DateRangePicker';
import { ForecastHorizonLinks, forecastContextLabel } from '@/components/ForecastHorizonLinks';
import { CostPerOutcomeStat } from '@/components/cfo/CostPerOutcomeStat';
import { BarChartClient } from '@/components/charts';
import { LariRecommendationsPanel } from '@/components/lari/LariRecommendationsPanel';
import { Card, DataTable, PageHeader, Stat, num, usd } from '@/components/ui';
import { fetchCfoView } from '@/lib/api/lari';
import { rangeHref, type DateBounds } from '@/lib/date-range';
import { forecastHorizonLabel } from '@/lib/forecast-horizon';
import type { CostBasisMode, CfoViewResponse } from '@/types/lari';

const BASIS_OPTIONS: { value: CostBasisMode; label: string }[] = [
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'computed', label: 'Computed' },
  { value: 'metered', label: 'Metered' },
];

const basisLabel = (b: CostBasisMode) => BASIS_OPTIONS.find((o) => o.value === b)?.label ?? b;

function CostStackStrip({ data }: { data: CfoViewResponse }) {
  const s = data.costProvenance.stack;
  return (
    <p className="mb-4 rounded-lg border border-edge bg-panel/50 px-4 py-2 text-xs text-muted">
      Projected ({forecastHorizonLabel(data.summary.forecastDays)}): tokens {usd(s.tokenUsageUsd)} · fixed cost{' '}
      {usd(s.fixedCostUsd)} · coding agents {usd(s.codingAgentUsd)} · Copilot {usd(s.copilotUsd)} · overhead{' '}
      {usd(s.qaEvalOverheadUsd)} · observed window {usd(data.summary.observedFullyLoadedCost)}
    </p>
  );
}

export function CostPerOutcomeView({
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchCfoView({ startDate: from, endDate: to, costBasis, forecastDays })
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

  const outcomeCount = data?.outcomeBreakdown.reduce((s, r) => s + r.outcomes, 0) ?? 0;
  const noOutcomesButSpend =
    !loading && data && outcomeCount === 0 && data.summary.fullyLoadedCost > 0;

  const modelChart = (data?.modelBreakdown ?? []).slice(0, 12).map((r) => ({
    model: r.model.length > 24 ? `${r.model.slice(0, 22)}…` : r.model,
    cost_per_1m: r.costPer1MTokens,
  }));

  const outcomeChart = (data?.outcomeBreakdown ?? []).map((r) => ({
    outcome_type: r.outcomeType,
    cost_per_outcome: r.costPerOutcome,
  }));

  return (
    <>
      <PageHeader
        title="Cost per outcome"
        subtitle={
          <DateRangePicker
            basePath="/cost-per-outcome"
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
              basePath="/cost-per-outcome"
              from={from}
              to={to}
              forecastDays={forecastDays}
              extraParams={{ basis: costBasis }}
            />
            <div className="flex gap-2">
              {BASIS_OPTIONS.map((opt) => (
                <Link
                  key={opt.value}
                  href={rangeHref('/cost-per-outcome', from, to, {
                    horizon: String(forecastDays),
                    basis: opt.value,
                  })}
                  className={`rounded px-3 py-1.5 text-sm ${
                    opt.value === costBasis ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                  }`}
                >
                  {opt.label}
                </Link>
              ))}
            </div>
            <Link
              href={rangeHref('/cfo', from, to, { horizon: String(forecastDays), basis: costBasis })}
              className="text-sm text-accent hover:underline"
            >
              Full CFO view →
            </Link>
          </div>
        }
      />

      <p className="mb-4 text-xs text-muted">
        {data
          ? forecastContextLabel(data.summary.forecastDays, data.summary.observedPeriodDays)
          : `${forecastHorizonLabel(forecastDays)} project spend · ${basisLabel(costBasis)} · ${from} → ${to}`}
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load cost metrics. Check API connectivity and try again.
        </p>
      )}

      <div className="mb-2 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-xl border border-edge bg-panel p-5">
              <div className="mb-2 h-3 w-24 rounded bg-edge" />
              <div className="h-7 w-32 rounded bg-edge" />
            </div>
          ))
        ) : data ? (
          <>
            <CostPerOutcomeStat
              summary={data.summary}
              outcomeCount={outcomeCount}
              subOverride={
                outcomeCount > 0
                  ? `${forecastHorizonLabel(data.summary.forecastDays)} projected`
                  : undefined
              }
            />
            <Stat
              label="Projected spend"
              value={usd(data.summary.fullyLoadedCost)}
              sub={`observed ${usd(data.summary.observedFullyLoadedCost)} in window`}
            />
            <Stat
              label="Projected token / API"
              value={usd(data.costProvenance.stack.tokenUsageUsd)}
              sub={`${basisLabel(data.summary.costBasis)} per-token or metered`}
            />
            <Stat
              label="Fixed cost (seats)"
              value={usd(data.costProvenance.stack.fixedCostUsd)}
              sub="fixed_costs licenses & subscriptions"
            />
            <Stat label="Business value" value={usd(data.summary.businessValue)} sub="outcomes + Copilot + Cursor activity" />
          </>
        ) : null}
      </div>

      {!loading && data && <CostStackStrip data={data} />}

      {noOutcomesButSpend && (
        <Card title="Spend without attributed outcomes">
          <p className="text-sm text-muted">
            {usd(data!.summary.fullyLoadedCost)} projected for {forecastHorizonLabel(data!.summary.forecastDays)} from
            token/API meter data and fixed seat costs, but no linked outcomes in the run-rate window. LARI recommendations
            below still flag wasted seats and model right-sizing.
          </p>
        </Card>
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

      <div className="mb-6">
        <LariRecommendationsPanel from={from} to={to} />
      </div>

      <Card title="Cost by model ($/1M tokens from usage)">
        {loading ? (
          <div className="flex h-[280px] animate-pulse items-center justify-center text-sm text-muted">Loading chart…</div>
        ) : modelChart.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No model usage in this run-rate window — connect a provider or import usage data.
          </p>
        ) : (
          <BarChartClient data={modelChart} xKey="model" yKey="cost_per_1m" />
        )}
      </Card>

      <Card title="Model token economics">
        {loading ? (
          <div className="animate-pulse py-8 text-center text-sm text-muted">Loading table…</div>
        ) : (data?.modelBreakdown ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No model usage in this run-rate window.</p>
        ) : (
          <DataTable
            columns={[
              { key: 'provider', label: 'Provider' },
              { key: 'model', label: 'Model' },
              { key: 'input', label: 'Input tokens', align: 'right' },
              { key: 'output', label: 'Output tokens', align: 'right' },
              { key: 'calls', label: 'Calls', align: 'right' },
              { key: 'per1m', label: '$/1M tokens', align: 'right' },
              { key: 'perTok', label: '$/token', align: 'right' },
              { key: 'observed', label: 'Observed cost', align: 'right' },
              { key: 'projected', label: 'Projected cost', align: 'right' },
            ]}
            rows={(data?.modelBreakdown ?? []).map((r) => ({
              provider: r.provider,
              model: r.model,
              input: num(r.inputTokens),
              output: num(r.outputTokens),
              calls: num(r.calls),
              per1m: usd(r.costPer1MTokens),
              perTok: `$${r.costPerToken.toFixed(6)}`,
              observed: usd(r.observedCostUsd),
              projected: usd(r.costUsd),
            }))}
          />
        )}
      </Card>

      {outcomeChart.length > 0 && (
        <Card title="Cost per outcome by type">
          <BarChartClient data={outcomeChart} xKey="outcome_type" yKey="cost_per_outcome" />
        </Card>
      )}

      {outcomeChart.length > 0 && (
        <Card title="Outcome unit economics">
          <DataTable
            columns={[
              { key: 'type', label: 'Outcome type' },
              { key: 'outcomes', label: 'Outcomes', align: 'right' },
              { key: 'value', label: 'Value', align: 'right' },
              { key: 'cost', label: 'Projected cost', align: 'right' },
              { key: 'cpo', label: 'Cost / outcome', align: 'right' },
              { key: 'conf', label: 'Avg conf', align: 'right' },
            ]}
            rows={(data?.outcomeBreakdown ?? []).map((r) => ({
              type: r.outcomeType,
              outcomes: String(r.outcomes),
              value: usd(r.businessValue),
              cost: usd(r.fullyLoadedCost),
              cpo: usd(r.costPerOutcome),
              conf: r.avgConfidence.toFixed(2),
            }))}
          />
        </Card>
      )}
    </>
  );
}

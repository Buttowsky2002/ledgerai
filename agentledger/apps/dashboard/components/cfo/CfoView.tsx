'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BarChartClient } from '@/components/charts';
import { LariRecommendationsPanel } from '@/components/lari/LariRecommendationsPanel';
import { Card, DataTable, PageHeader, Stat, usd } from '@/components/ui';
import { fetchCfoView } from '@/lib/api/lari';
import type { CfoViewResponse } from '@/types/lari';

const LEVELS = [0, 0.3, 0.5, 0.7, 0.9] as const;
const DEFAULT_LEVEL = 0.5;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function SkeletonStat() {
  return (
    <div className="animate-pulse rounded-xl border border-edge bg-panel p-5">
      <div className="mb-2 h-3 w-24 rounded bg-edge" />
      <div className="h-7 w-32 rounded bg-edge" />
    </div>
  );
}

export function CfoView({
  from,
  to,
  minConfidence,
}: {
  from: string;
  to: string;
  minConfidence: number;
}) {
  const [data, setData] = useState<CfoViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchCfoView({ startDate: from, endDate: to, confidenceThreshold: minConfidence })
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
  }, [from, to, minConfidence]);

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
        subtitle={`Risk-adjusted ROI · confidence ≥ ${minConfidence} · ${from} → ${to}`}
        actions={
          <div className="flex gap-2">
            {LEVELS.map((lvl) => (
              <Link
                key={lvl}
                href={`/cfo?min=${lvl}`}
                className={`rounded px-3 py-1.5 text-sm tabular-nums ${
                  lvl === minConfidence ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
                }`}
              >
                ≥ {lvl}
              </Link>
            ))}
          </div>
        }
      />

      {error && (
        <p className="mb-4 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load CFO metrics. Check API connectivity and try again.
        </p>
      )}

      <div className="mb-2 grid grid-cols-4 gap-4">
        {loading ? (
          <>
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
              sub={`nominal ${usd(data.summary.nominalRoi)}`}
            />
            <Stat
              label="Business value"
              value={usd(data.summary.businessValue)}
              sub={`ROI margin ${pct(data.summary.roiMargin)}`}
            />
            <Stat
              label="Fully-loaded cost"
              value={usd(data.summary.fullyLoadedCost)}
              sub="tokens + QA + eval + integration + platform + seats + coding agents"
            />
            <Stat
              label="Forecast / month"
              value={usd(data.summary.forecastPerMonth)}
              sub={`run-rate over ${data.summary.runRateMonths} mo`}
            />
          </>
        ) : null}
      </div>

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
        Risk-adjusted ROI discounts value by attribution confidence and agent risk exposure, net of fully-loaded
        cost. Links below confidence {minConfidence} are excluded from these headline figures.
      </p>

      <div className="mb-6">
        <LariRecommendationsPanel from={from} to={to} />
      </div>

      {empty ? (
        <Card title="No LARI outcomes">
          <p className="text-sm text-muted">
            No LARI outcomes found for this period. Connect providers, import usage, or create outcome mappings.
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
                  { key: 'nominal', label: 'Nominal ROI', align: 'right' },
                  { key: 'riskAdj', label: 'Risk-adj ROI', align: 'right' },
                  { key: 'conf', label: 'Avg conf', align: 'right' },
                ]}
                rows={(data?.outcomeBreakdown ?? []).map((r) => ({
                  type: r.outcomeType,
                  outcomes: String(r.outcomes),
                  value: usd(r.businessValue),
                  cost: usd(r.fullyLoadedCost),
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

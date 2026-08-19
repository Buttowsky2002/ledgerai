'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, BadgeTone, Card, usd } from '@/components/ui';
import { fetchProductWorth } from '@/lib/api/lari';
import type { ProductWorthEntry, ProductWorthResponse, ProductWorthVerdict, SpendTrend } from '@/types/lari';

const VERDICT_META: Record<ProductWorthVerdict, { label: string; tone: BadgeTone }> = {
  worth_it: { label: 'Worth it', tone: 'pos' },
  marginal: { label: 'Marginal', tone: 'warn' },
  not_worth_it: { label: 'Not worth it', tone: 'neg' },
  insufficient_data: { label: 'Need more data', tone: 'neutral' },
};

const TREND_LABEL: Record<SpendTrend, string> = {
  up: '↑ vs prior period',
  down: '↓ vs prior period',
  flat: '→ flat',
  insufficient: '',
};

const DATA_MODE_LABEL: Record<string, string> = {
  import_only: 'CSV import',
  live_only: 'Live',
  mixed: 'Mixed sources',
};

const BASIS_LABEL: Record<string, string> = {
  outcomes: 'Outcome-linked',
  utilization: 'Utilization',
  productivity_proxy: 'Productivity estimate',
  mixed: 'Mixed signals',
  none: 'Spend only',
};

function DriverList({ drivers }: { drivers: ProductWorthEntry['topDrivers'] }) {
  if (drivers.length === 0) {
    return <span className="text-muted">—</span>;
  }
  return (
    <ul className="space-y-0.5 text-xs text-muted">
      {drivers.map((d) => (
        <li key={`${d.type}-${d.label}`}>
          <span className="text-gray-300">{d.label}</span>
          <span className="ml-1">({usd(d.costUsd)})</span>
        </li>
      ))}
    </ul>
  );
}

export function ProductWorthPanel({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<ProductWorthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchProductWorth({ startDate: from, endDate: to })
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
  }, [from, to]);

  const products = data?.products ?? [];

  return (
    <Card
      title="Product worth"
      subtitle={`Is the spend justified? · ${from} → ${to}`}
      actions={
        data ? (
          <div className="flex flex-wrap gap-2 text-xs">
            {data.summary.portfolioWorthRatio !== null && (
              <Badge tone={data.summary.portfolioWorthRatio >= 1 ? 'pos' : 'warn'}>
                {data.summary.portfolioWorthRatio.toFixed(2)}× portfolio value/$
              </Badge>
            )}
            <Badge tone={data.summary.notWorthItCount > 0 ? 'neg' : 'pos'}>
              {data.summary.worthItCount}/{data.summary.productCount} worth it
            </Badge>
          </div>
        ) : undefined
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">
          Could not load product worth scorecard.
        </p>
      )}
      {loading ? (
        <div className="animate-pulse space-y-3 py-4">
          <div className="h-12 rounded-lg bg-edge" />
          <div className="h-12 rounded-lg bg-edge" />
        </div>
      ) : products.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No AI products with spend in this range — connect a billing source or import usage data.
        </p>
      ) : (
        <div className="space-y-4">
          {products.map((p) => {
            const meta = VERDICT_META[p.verdict];
            const trendLabel = TREND_LABEL[p.spendTrend];
            return (
              <div key={p.product} className="rounded-lg border border-edge bg-panel/50 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-100">{p.product}</span>
                  <Badge tone={meta.tone} dot>
                    {meta.label}
                  </Badge>
                  {trendLabel && (
                    <Badge tone={p.spendTrend === 'up' ? 'warn' : 'neutral'}>{trendLabel}</Badge>
                  )}
                  {p.connectOutcomesPrompt && (
                    <Link href="/settings/connectors" className="text-xs text-accent hover:underline">
                      Connect outcomes →
                    </Link>
                  )}
                  {p.dataMode && p.dataMode !== 'unknown' && (
                    <Badge tone="neutral">{DATA_MODE_LABEL[p.dataMode] ?? p.dataMode}</Badge>
                  )}
                  <span className="ml-auto text-sm text-muted">
                    {usd(p.totalSpendUsd)} spend
                    {p.worthRatio !== null && (
                      <span className="ml-2">{p.worthRatio.toFixed(2)}× value/$</span>
                    )}
                  </span>
                </div>
                <p className="text-sm text-muted">{p.spendNarrative}</p>
                {p.recommendedBudgetUsd !== null && (
                  <p className="mt-2 text-xs text-accent">
                    Suggested budget: {usd(p.recommendedBudgetUsd)}/mo
                    {p.monthlyRunRateUsd !== p.recommendedBudgetUsd && (
                      <span className="text-muted">
                        {' '}
                        (run-rate {usd(p.monthlyRunRateUsd)}/mo)
                      </span>
                    )}
                  </p>
                )}
                {p.topDrivers.length > 0 && (
                  <div className="mt-2">
                    <DriverList drivers={p.topDrivers} />
                  </div>
                )}
                <p className="mt-1 text-[11px] text-muted">
                  Basis: {BASIS_LABEL[p.confidenceBasis] ?? p.confidenceBasis} · confidence{' '}
                  {p.confidenceScore}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

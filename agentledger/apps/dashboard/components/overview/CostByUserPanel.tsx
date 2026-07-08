'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card, DataTable, num, usd } from '@/components/ui';
import { decodeRange, RANGE_COOKIE, resolveRangeWithCookie } from '@/lib/date-range';

type AllocationRow = {
  key: string;
  cost_usd: number | string;
  calls: string | number;
  spend_trend?: 'up' | 'down' | 'flat' | 'insufficient';
  trend_change_pct?: number;
  trend_change_usd?: number;
};

type SpendTrendDir = NonNullable<AllocationRow['spend_trend']>;

function SpendTrendCell({
  trend,
  changePct,
  changeUsd,
}: {
  trend?: SpendTrendDir;
  changePct?: number;
  changeUsd?: number;
}) {
  if (!trend || trend === 'insufficient') {
    return <span className="text-xs text-muted">—</span>;
  }
  const label = trend === 'up' ? '↑ Up' : trend === 'down' ? '↓ Down' : '→ Flat';
  const tone = trend === 'up' ? 'text-warn' : trend === 'down' ? 'text-pos' : 'text-muted';
  const delta =
    changeUsd != null && changeUsd !== 0
      ? `${changeUsd > 0 ? '+' : ''}${usd(changeUsd)}/day`
      : null;
  const title =
    changePct != null
      ? `${changePct > 0 ? '+' : ''}${changePct}% avg daily spend (latter half vs first)`
      : undefined;
  return (
    <span className={`inline-flex flex-col items-end text-xs font-medium ${tone}`} title={title}>
      <span>{label}</span>
      {delta && trend !== 'flat' && <span className="num text-[11px] opacity-90">{delta}</span>}
    </span>
  );
}

function readCookieRange(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${RANGE_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function resolveClientRange(searchParams: URLSearchParams): { from: string; to: string } {
  const fromUrl = searchParams.get('from');
  const toUrl = searchParams.get('to');
  if (fromUrl && toUrl) return { from: fromUrl.slice(0, 10), to: toUrl.slice(0, 10) };
  return resolveRangeWithCookie(
    { from: fromUrl ?? undefined, to: toUrl ?? undefined },
    readCookieRange(),
    90,
  );
}

export function CostByUserPanel({
  initialRows,
  initialFrom,
  initialTo,
}: {
  initialRows: AllocationRow[];
  initialFrom: string;
  initialTo: string;
}) {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState(initialRows);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState({ from: initialFrom, to: initialTo });

  useEffect(() => {
    const next = resolveClientRange(searchParams);
    setRange(next);

    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams({ dimension: 'user', from: next.from, to: next.to });
    fetch(`/api/analytics/user-allocation?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  return (
    <Card
      title="Cost by user"
      subtitle={`${range.from} → ${range.to} · provider-reported metered spend + coding-agent usage (excludes subscription-included usage value)`}
      actions={
        <Link
          href={`/users?from=${range.from}&to=${range.to}`}
          className="text-xs text-accent hover:underline"
        >
          Member directory →
        </Link>
      }
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">Updating user spend…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No per-user spend in this range.</p>
      ) : (
        <DataTable
          columns={[
            { key: 'user', label: 'User' },
            { key: 'cost', label: 'Spend', align: 'right' },
            { key: 'trend', label: 'Daily trend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
          ]}
          rows={rows.map((r) => ({
            user:
              r.key === 'Unassigned' ? (
                <span className="text-warn">{r.key}</span>
              ) : (
                <Link
                  href={`/users/${encodeURIComponent(r.key)}?from=${range.from}&to=${range.to}`}
                  className="text-accent hover:underline"
                >
                  {r.key}
                </Link>
              ),
            cost: usd(Number(r.cost_usd)),
            trend: (
              <SpendTrendCell
                trend={r.spend_trend}
                changePct={r.trend_change_pct}
                changeUsd={r.trend_change_usd}
              />
            ),
            calls: num(r.calls),
          }))}
        />
      )}
    </Card>
  );
}

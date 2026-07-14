'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DataTable, Stat, num, usd } from '@/components/ui';

export interface CursorSpendSummary {
  billedUsd: number;
  meteredOverageUsd: number;
  usageValueUsd: number;
  seatLicenseUsd: number;
  seatCount: number;
  seatUnitUsdPerMonth: number;
  seatSource: 'fixed_costs' | 'subscription_plan' | 'none';
  activeMembersInRange: number;
  totalCalls: number;
  includedCalls: number;
  onDemandCalls: number;
  legacyUntagged: boolean;
  disclaimer: string;
  modelMix: {
    model: string;
    billed_usd: number;
    usage_value_usd: number;
    calls: number;
  }[];
}

function seatSourceLabel(source: CursorSpendSummary['seatSource']): string {
  if (source === 'fixed_costs') return 'Fixed overhead';
  if (source === 'subscription_plan') return 'Subscription plan';
  return 'Not configured';
}

export function CursorPlatformDetail({
  from,
  to,
  initialData,
  initialLoadError = false,
}: {
  from: string;
  to: string;
  initialData?: CursorSpendSummary | null;
  initialLoadError?: boolean;
}) {
  const ssrLoaded = initialData !== undefined || initialLoadError;
  const [data, setData] = useState<CursorSpendSummary | null>(initialData ?? null);
  const [loadError, setLoadError] = useState(initialLoadError);
  const [loading, setLoading] = useState(!ssrLoaded);

  useEffect(() => {
    setData(initialData ?? null);
    setLoadError(initialLoadError);
    if (ssrLoaded) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    fetch(`/api/analytics/cursor-spend?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!r.ok) {
          if (!cancelled) setLoadError(true);
          return null;
        }
        const text = await r.text();
        if (!text) return null;
        try {
          return JSON.parse(text) as CursorSpendSummary | null;
        } catch {
          if (!cancelled) setLoadError(true);
          return null;
        }
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, initialData, initialLoadError, ssrLoaded]);

  if (loading) {
    return <p className="py-6 text-center text-sm text-muted">Loading Cursor billing breakdown…</p>;
  }

  if (loadError) {
    return (
      <p className="py-6 text-center text-sm text-warn">
        Could not load Cursor billing breakdown. Refresh the page or check API logs.
      </p>
    );
  }

  if (!data) {
    return (
      <p className="py-6 text-center text-sm text-muted">
        No Cursor usage in this range. Connect and sync the Cursor Admin API connector.
      </p>
    );
  }

  const metered = data.meteredOverageUsd ?? data.billedUsd;
  const seat = data.seatLicenseUsd ?? 0;
  const totalInvoiceStyle = seat + metered;
  const models = [...(data.modelMix ?? [])].sort((a, b) => b.usage_value_usd - a.usage_value_usd);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Seat licenses"
          value={usd(seat)}
          accent={seat > 0}
          sub={
            data.seatCount > 0 && data.seatUnitUsdPerMonth > 0
              ? `${data.seatCount} active members × ${usd(data.seatUnitUsdPerMonth)}/mo · ${seatSourceLabel(data.seatSource)}`
              : `${seatSourceLabel(data.seatSource)}`
          }
        />
        <Stat
          label={data.legacyUntagged ? 'Metered (legacy)' : 'Metered overage'}
          value={usd(metered)}
          accent={seat <= 0 && metered > 0}
          sub="On-demand billed (chargedCents)"
        />
        <Stat
          label="Included usage value"
          value={usd(data.usageValueUsd)}
          sub="Subscription pool — not billed"
        />
        <Stat label="Total (seats + metered)" value={usd(totalInvoiceStyle)} />
        <Stat
          label="Active members"
          value={num(data.activeMembersInRange)}
          sub={`${num(data.onDemandCalls)} on-demand / ${num(data.includedCalls)} included events`}
        />
      </div>

      {data.seatSource === 'none' && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
          Cursor seat prices are not pulled from the usage API. Add a Cursor line under{' '}
          <Link href="/admin/fixed-overhead" className="underline hover:text-white">
            Fixed overhead
          </Link>{' '}
          (vendor: cursor, type: seat_license) or configure an{' '}
          <Link href="/settings" className="underline hover:text-white">
            AI subscription plan
          </Link>{' '}
          to show license cost separately from metered overage.
        </p>
      )}

      {models.length > 0 ? (
        <DataTable
          columns={[
            { key: 'model', label: 'Model' },
            { key: 'billed', label: 'Metered overage', align: 'right' },
            { key: 'usage', label: 'Included usage value', align: 'right' },
            { key: 'calls', label: 'Events', align: 'right' },
          ]}
          rows={models.map((m) => ({
            model: m.model || '(default)',
            billed: usd(m.billed_usd),
            usage: usd(m.usage_value_usd),
            calls: num(m.calls),
          }))}
        />
      ) : null}

      <p className="text-xs leading-relaxed text-muted">{data.disclaimer}</p>
    </div>
  );
}

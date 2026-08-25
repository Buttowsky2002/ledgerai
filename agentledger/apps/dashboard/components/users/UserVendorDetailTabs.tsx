'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, DataTable, num, usd } from '../ui';
import { VendorSpendPie } from '../VendorSpendPie';
import { vendorShortLabel, type VendorSpendSlice, type VendorUsageSlice } from '@/lib/vendor-spend';

type Props = {
  userId: string;
  from: string;
  to: string;
  vendors: string[];
  vendorSpend: Record<string, VendorSpendSlice>;
  vendorUsage: Record<string, VendorUsageSlice>;
};

export function UserVendorDetailTabs({ userId, from, to, vendors, vendorSpend, vendorUsage }: Props) {
  const activeVendors = vendors.filter((v) => (vendorSpend[v]?.total_usd ?? 0) > 0 || (vendorUsage[v]?.calls ?? 0) > 0);
  const tabs = activeVendors.length > 0 ? activeVendors : vendors;
  const [tab, setTab] = useState(tabs[0] ?? 'cursor');

  const spend = vendorSpend[tab];
  const usage = vendorUsage[tab];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {tabs.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              v === tab ? 'bg-accent/20 text-white ring-1 ring-inset ring-accent/30' : 'border border-edge text-muted hover:bg-white/5'
            }`}
          >
            {vendorShortLabel(v)}
          </button>
        ))}
      </div>

      {spend && spend.total_usd > 0 && (
        <VendorSpendPie seatUsd={spend.seat_usd} overageUsd={spend.overage_usd} />
      )}

      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Calls</p>
          <p className="num text-lg text-gray-100">{num(usage?.calls ?? 0)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Tokens</p>
          <p className="num text-lg text-gray-100">{num(usage?.tokens ?? 0)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Total spend</p>
          <p className="num text-lg text-gray-100">{usd(spend?.total_usd ?? 0)}</p>
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Models used</p>
        {(usage?.models?.length ?? 0) > 0 ? (
          <span className="inline-flex flex-wrap gap-1">
            {usage!.models.map((label) => (
              <Badge key={label} tone="neutral">
                {label}
              </Badge>
            ))}
          </span>
        ) : (
          <p className="text-sm text-muted">—</p>
        )}
      </div>

      {(usage?.model_breakdown?.length ?? 0) > 0 && (
        <DataTable
          columns={[
            { key: 'model', label: 'Model' },
            { key: 'spend', label: 'Spend', align: 'right' },
            { key: 'calls', label: 'Calls', align: 'right' },
          ]}
          rows={usage!.model_breakdown.map((row) => ({
            model: row.model,
            spend: usd(row.spend_usd),
            calls: num(row.calls),
          }))}
        />
      )}

      <p className="text-xs text-muted">
        <Link href={`/users?from=${from}&to=${to}`} className="text-accent hover:underline">
          ← Member directory
        </Link>
      </p>
    </div>
  );
}

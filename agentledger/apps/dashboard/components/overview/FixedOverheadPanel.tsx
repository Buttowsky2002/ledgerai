import Link from 'next/link';
import { PieChartClient } from '@/components/charts';
import { Card, DataTable, usd } from '@/components/ui';
import { vendorLabel } from '@/lib/fixed-cost-catalog';
import { vendorDetailHref } from '@/lib/vendor-routes';
import { proxyApi } from '@/lib/api';
import {
  formatSignedUsd,
  monthLabel,
  previousCalendarMonth,
} from '@/lib/seat-price-delta';

type OrgVendorRow = {
  vendor: string;
  seat_usd: number;
  budget_overage_usd: number;
  total_usd: number;
  seats?: number;
  prior_seats?: number | null;
  usd_from_seats?: number;
  usd_from_rate?: number;
  prior_period_month?: string | null;
};

type VendorBillingResponse = {
  vendors: OrgVendorRow[];
  total_cost_of_ai: number;
  seat_change_usd?: number;
  seat_change_month?: string | null;
};

/** True when seats moved vs the previous billing month (not a first-time entry). */
function hasSeatCountChange(row: OrgVendorRow): boolean {
  return (
    row.prior_seats != null &&
    row.seats != null &&
    row.seats !== row.prior_seats &&
    (row.usd_from_seats ?? 0) !== 0
  );
}

function SeatChangeCell({ row }: { row: OrgVendorRow }) {
  if (!hasSeatCountChange(row)) {
    return <span className="text-muted">—</span>;
  }

  const seatDelta = (row.seats as number) - (row.prior_seats as number);
  const fromSeats = row.usd_from_seats ?? 0;
  const tone = fromSeats > 0 ? 'text-warn' : 'text-pos';
  const seatLabel = `${seatDelta > 0 ? '+' : ''}${seatDelta} seat${Math.abs(seatDelta) === 1 ? '' : 's'}`;

  return (
    <span className={`num text-xs ${tone}`}>
      {seatLabel} · {formatSignedUsd(fromSeats)}
    </span>
  );
}

export async function FixedOverheadPanel({ from, to }: { from: string; to: string }) {
  const qs = new URLSearchParams({ from, to }).toString();
  const vendorBillingRes = await proxyApi(`/v1/analytics/vendor-billing?${qs}`);

  const vendorBilling =
    vendorBillingRes.ok && vendorBillingRes.data && typeof vendorBillingRes.data === 'object'
      ? (vendorBillingRes.data as VendorBillingResponse)
      : { vendors: [], total_cost_of_ai: 0 };

  const orgVendors = vendorBilling.vendors ?? [];
  const grandSeat = orgVendors.reduce((s, r) => s + r.seat_usd, 0);
  const grandOverage = orgVendors.reduce((s, r) => s + r.budget_overage_usd, 0);
  const grandTotal = vendorBilling.total_cost_of_ai ?? grandSeat + grandOverage;
  const subscriptionPct = grandTotal > 0 ? (grandSeat / grandTotal) * 100 : 0;
  const seatChangeUsd = vendorBilling.seat_change_usd ?? 0;
  const seatChangeMonth = vendorBilling.seat_change_month ?? null;
  const vsLabel =
    seatChangeMonth && orgVendors.some((v) => v.prior_period_month != null && hasSeatCountChange(v))
      ? monthLabel(previousCalendarMonth(seatChangeMonth))
      : null;

  const pieData = orgVendors.flatMap((v) => {
    const slices = [];
    if (v.seat_usd > 0) slices.push({ label: `${vendorLabel(v.vendor)} seats`, cost_usd: v.seat_usd });
    if (v.budget_overage_usd > 0) slices.push({ label: `${vendorLabel(v.vendor)} overage`, cost_usd: v.budget_overage_usd });
    return slices;
  });

  return (
    <Card
      title="Fixed / overhead costs"
      subtitle={`${from} → ${to} · seat subscriptions prorated by days in range · seat change vs previous billing month`}
      actions={
        <Link href="/admin/fixed-overhead" className="text-xs text-accent hover:underline">
          Manage seats & plans
        </Link>
      }
    >
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Total cost of AI</p>
          <p className="num text-xl font-semibold text-gray-100">{usd(grandTotal)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Budget overage</p>
          <p className="num text-xl text-gray-200">{usd(grandOverage)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Subscription amount</p>
          <p className="num text-xl text-warn">{usd(grandSeat)}</p>
          <p className="text-xs text-muted">{subscriptionPct.toFixed(1)}% of total</p>
          {seatChangeUsd !== 0 && (
            <p className={`text-xs ${seatChangeUsd > 0 ? 'text-warn' : 'text-pos'}`}>
              {formatSignedUsd(seatChangeUsd)} from seat changes
              {vsLabel ? ` · vs ${vsLabel}` : ''}
            </p>
          )}
        </div>
      </div>

      {pieData.length > 0 && (
        <div className="mb-6">
          <PieChartClient data={pieData} nameKey="label" valueKey="cost_usd" showPercent />
        </div>
      )}

      {orgVendors.length > 0 ? (
        <DataTable
          columns={[
            { key: 'vendor', label: 'Vendor' },
            { key: 'seat', label: 'Subscription amount', align: 'right' },
            { key: 'seatChange', label: 'Seat change', align: 'right' },
            { key: 'overage', label: 'Budget overage', align: 'right' },
            { key: 'total', label: 'Total', align: 'right' },
          ]}
          rows={orgVendors.map((r) => ({
            vendor: (
              <Link href={vendorDetailHref(r.vendor, from, to)} className="text-accent hover:underline">
                {vendorLabel(r.vendor)}
              </Link>
            ),
            seat: usd(r.seat_usd),
            seatChange: <SeatChangeCell row={r} />,
            overage: usd(r.budget_overage_usd),
            total: usd(r.total_usd),
          }))}
          footerRows={[
            {
              vendor: <span className="text-xs uppercase tracking-wide text-muted">Grand total</span>,
              seat: usd(grandSeat),
              seatChange:
                seatChangeUsd !== 0 ? (
                  <span className={`num text-xs ${seatChangeUsd > 0 ? 'text-warn' : 'text-pos'}`}>
                    {formatSignedUsd(seatChangeUsd)}
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                ),
              overage: usd(grandOverage),
              total: usd(grandTotal),
            },
          ]}
        />
      ) : (
        <p className="text-sm text-muted">
          No fixed overhead recorded for this period.{' '}
          <Link href="/admin/fixed-overhead" className="text-accent hover:underline">
            Add vendor seats & plans
          </Link>
        </p>
      )}
    </Card>
  );
}

import Link from 'next/link';
import { PieChartClient } from '@/components/charts';
import { Card, DataTable, usd } from '@/components/ui';
import { vendorLabel } from '@/lib/fixed-cost-catalog';
import {
  billingMonthsInRange,
  currentMonthlySeatRunRate,
  latestBillingMonthInRange,
  latestSeatByVendor,
  periodSeatTotalForRange,
  seatLookupFromDate,
  type FixedCostSeatRow,
} from '@/lib/overview-seat-monthly';
import { vendorDetailHref } from '@/lib/vendor-routes';
import { proxyApi } from '@/lib/api';
import { formatSignedUsd, monthLabel, previousCalendarMonth } from '@/lib/seat-price-delta';
import { usdPerMonth } from '@/lib/usd-per-month';

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

export type VendorBillingData = {
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

export async function FixedOverheadPanel({
  from,
  to,
  vendorBilling: vendorBillingProp,
}: {
  from: string;
  to: string;
  vendorBilling?: VendorBillingData;
}) {
  const qs = new URLSearchParams({ from, to }).toString();
  let vendorBilling = vendorBillingProp;
  if (!vendorBilling) {
    const vendorBillingRes = await proxyApi(`/v1/analytics/vendor-billing?${qs}`);
    vendorBilling =
      vendorBillingRes.ok && vendorBillingRes.data && typeof vendorBillingRes.data === 'object'
        ? (vendorBillingRes.data as VendorBillingData)
        : { vendors: [], total_cost_of_ai: 0 };
  }

  const fixedCostRes = await proxyApi(
    `/v1/fixed-costs?${new URLSearchParams({ from: seatLookupFromDate(to), to }).toString()}`,
  );
  const fixedRows: FixedCostSeatRow[] =
    fixedCostRes.ok && Array.isArray(fixedCostRes.data)
      ? (fixedCostRes.data as FixedCostSeatRow[])
      : [];

  const billingMonth = latestBillingMonthInRange(from, to);
  const billingMonthCount = billingMonthsInRange(from, to).length;
  const latestByVendor = latestSeatByVendor(fixedRows);

  const orgVendors = vendorBilling.vendors ?? [];
  let monthlySeatRunRate = currentMonthlySeatRunRate(fixedRows);
  let periodSeatTotalUsd = periodSeatTotalForRange(fixedRows, from, to);
  const vendorBillingPeriodSeat = orgVendors.reduce((s, r) => s + r.seat_usd, 0);

  for (const row of orgVendors) {
    if (row.seat_usd <= 0 || latestByVendor.has(row.vendor)) {
      continue;
    }
    const share =
      billingMonthCount === 1 ? row.seat_usd : row.seat_usd / Math.max(billingMonthCount, 1);
    monthlySeatRunRate = Math.round((monthlySeatRunRate + share) * 100) / 100;
    periodSeatTotalUsd = Math.round((periodSeatTotalUsd + row.seat_usd) * 100) / 100;
  }
  if (monthlySeatRunRate <= 0 && vendorBillingPeriodSeat > 0) {
    monthlySeatRunRate =
      billingMonthCount === 1
        ? vendorBillingPeriodSeat
        : vendorBillingPeriodSeat / billingMonthCount;
    periodSeatTotalUsd = vendorBillingPeriodSeat;
  }

  function subscriptionLabel(vendor: string, fallbackSeatUsd: number): string {
    const fromRows = latestByVendor.get(vendor.toLowerCase());
    const monthly = fromRows?.seat_usd ?? fallbackSeatUsd / Math.max(billingMonthCount, 1);
    return usdPerMonth(Math.round(monthly * 100) / 100);
  }

  const grandSeat = periodSeatTotalUsd;
  const grandSeatMonthly = Math.round(monthlySeatRunRate * 100) / 100;
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
    if (v.seat_usd > 0) {
      slices.push({ label: `${vendorLabel(v.vendor)} seats`, cost_usd: v.seat_usd });
    }
    if (v.budget_overage_usd > 0) {
      slices.push({ label: `${vendorLabel(v.vendor)} overage`, cost_usd: v.budget_overage_usd });
    }
    return slices;
  });

  return (
    <Card
      title="Fixed / overhead costs"
      subtitle={`${from} → ${to} · ${monthLabel(`${billingMonth}-01`)} run-rate · seat change vs previous billing month`}
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
          <p className="text-xs uppercase tracking-wide text-muted">Subscription run-rate</p>
          <p className="num text-xl text-warn">{usdPerMonth(grandSeatMonthly)}</p>
          {billingMonthCount > 1 && (
            <p className="text-xs text-muted">
              {usd(grandSeat)} across {billingMonthCount} billing months
            </p>
          )}
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
            { key: 'seat', label: 'Subscription /mo', align: 'right' },
            { key: 'seatChange', label: 'Seat change', align: 'right' },
            { key: 'overage', label: 'Budget overage', align: 'right' },
            { key: 'total', label: 'Total', align: 'right' },
          ]}
          rows={orgVendors.map((r) => ({
            vendor: (
              <Link
                href={vendorDetailHref(r.vendor, from, to)}
                className="text-accent hover:underline"
              >
                {vendorLabel(r.vendor)}
              </Link>
            ),
            seat: subscriptionLabel(r.vendor, r.seat_usd),
            seatChange: <SeatChangeCell row={r} />,
            overage: usd(r.budget_overage_usd),
            total: usd(r.total_usd),
          }))}
          footerRows={[
            {
              vendor: (
                <span className="text-xs uppercase tracking-wide text-muted">Grand total</span>
              ),
              seat: usdPerMonth(grandSeatMonthly),
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

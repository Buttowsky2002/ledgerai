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
  seatLookupToDate,
  type FixedCostSeatRow,
  type SeatTierSnap,
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

type DisplayVendorRow = {
  vendor: string;
  seat_usd: number;
  seats?: number;
  budget_overage_usd: number;
  total_usd: number;
  prior_seats?: number | null;
  usd_from_seats?: number;
  prior_period_month?: string | null;
  tiers?: SeatTierSnap[];
};

/** True when seats moved vs the previous billing month (not a first-time entry). */
function hasSeatCountChange(row: DisplayVendorRow): boolean {
  return (
    row.prior_seats != null &&
    row.seats != null &&
    row.seats !== row.prior_seats &&
    (row.usd_from_seats ?? 0) !== 0
  );
}

function SeatChangeCell({ row }: { row: DisplayVendorRow }) {
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

function SeatCountCell({ row }: { row: DisplayVendorRow }) {
  const visible = (row.tiers ?? []).filter((t) => t.seats > 0 || t.seat_usd > 0);
  if (visible.length > 0) {
    return (
      <div className="text-right">
        {visible.map((t) => (
          <p key={t.class} className="text-xs text-muted">
            <span className="num text-gray-200">{t.seats}</span> {t.class}
            {t.unit_usd > 0 ? <span className="num"> · {usd(t.unit_usd)}</span> : null}
          </p>
        ))}
      </div>
    );
  }
  return <span>{row.seats != null && row.seats > 0 ? String(row.seats) : '—'}</span>;
}

/** One row per vendor: current monthly seats + in-range overage. */
function buildVendorDisplayRows(
  latestByVendor: Map<
    string,
    { seat_usd: number; seats: number; period_month: string; tiers?: SeatTierSnap[] }
  >,
  orgVendors: OrgVendorRow[],
): DisplayVendorRow[] {
  const byVendor = new Map<string, DisplayVendorRow>();

  for (const [vendor, snap] of latestByVendor) {
    byVendor.set(vendor, {
      vendor,
      seat_usd: snap.seat_usd,
      seats: snap.seats > 0 ? snap.seats : undefined,
      budget_overage_usd: 0,
      total_usd: snap.seat_usd,
      tiers: snap.tiers,
    });
  }

  for (const row of orgVendors) {
    const existing = byVendor.get(row.vendor);
    if (existing) {
      existing.budget_overage_usd = row.budget_overage_usd;
      existing.total_usd = Math.round((existing.seat_usd + row.budget_overage_usd) * 100) / 100;
      existing.prior_seats = row.prior_seats;
      existing.usd_from_seats = row.usd_from_seats;
      existing.prior_period_month = row.prior_period_month;
      if (existing.seats == null && row.seats != null) {
        existing.seats = row.seats;
      }
      continue;
    }
    if (row.seat_usd <= 0 && row.budget_overage_usd <= 0) {
      continue;
    }
    byVendor.set(row.vendor, {
      vendor: row.vendor,
      seat_usd: row.seat_usd,
      seats: row.seats,
      budget_overage_usd: row.budget_overage_usd,
      total_usd: row.total_usd,
      prior_seats: row.prior_seats,
      usd_from_seats: row.usd_from_seats,
      prior_period_month: row.prior_period_month,
    });
  }

  return [...byVendor.values()].sort((a, b) => b.total_usd - a.total_usd);
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

  const seatFrom = seatLookupFromDate(to);
  const seatTo = seatLookupToDate(to);
  const fixedCostRes = await proxyApi(
    `/v1/fixed-costs?${new URLSearchParams({ from: seatFrom, to: seatTo }).toString()}`,
  );
  const fixedRows: FixedCostSeatRow[] =
    fixedCostRes.ok && Array.isArray(fixedCostRes.data)
      ? (fixedCostRes.data as FixedCostSeatRow[])
      : [];

  const billingMonth = latestBillingMonthInRange(from, to);
  const billingMonthCount = billingMonthsInRange(from, to).length;
  const latestByVendor = latestSeatByVendor(fixedRows);
  const orgVendors = vendorBilling.vendors ?? [];
  const displayVendors = buildVendorDisplayRows(latestByVendor, orgVendors);

  let monthlySeatRunRate = currentMonthlySeatRunRate(fixedRows);
  let periodSeatTotalUsd = periodSeatTotalForRange(fixedRows, from, to);

  for (const row of displayVendors) {
    if (row.seat_usd <= 0 || latestByVendor.has(row.vendor)) {
      continue;
    }
    // Connector-only seats (Cursor/GitHub) not in admin fixed_costs.
    monthlySeatRunRate = Math.round((monthlySeatRunRate + row.seat_usd) * 100) / 100;
    periodSeatTotalUsd =
      Math.round((periodSeatTotalUsd + row.seat_usd * Math.max(billingMonthCount, 1)) * 100) / 100;
  }

  const grandSeat = periodSeatTotalUsd;
  const grandSeatMonthly = Math.round(monthlySeatRunRate * 100) / 100;
  const grandOverage = displayVendors.reduce((s, r) => s + r.budget_overage_usd, 0);
  const grandTotal = Math.round((grandSeatMonthly + grandOverage) * 100) / 100;
  const subscriptionPct = grandTotal > 0 ? (grandSeatMonthly / grandTotal) * 100 : 0;
  const seatChangeUsd = vendorBilling.seat_change_usd ?? 0;
  const seatChangeMonth = vendorBilling.seat_change_month ?? null;
  const vsLabel =
    seatChangeMonth &&
    displayVendors.some((v) => v.prior_period_month != null && hasSeatCountChange(v))
      ? monthLabel(previousCalendarMonth(seatChangeMonth))
      : null;

  // One pie slice per vendor (seats + overage combined) — not separate seat/overage tabs.
  const pieData = displayVendors
    .filter((v) => v.total_usd > 0)
    .map((v) => ({
      label: vendorLabel(v.vendor),
      cost_usd: v.seat_usd + v.budget_overage_usd,
    }));

  return (
    <Card
      title="Fixed / overhead costs"
      subtitle={`${from} → ${to} · current seat run-rate · seat change vs previous billing month`}
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
          <p className="text-xs text-muted">
            {usdPerMonth(grandSeatMonthly)} seats + {usd(grandOverage)} overage
          </p>
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

      {displayVendors.length > 0 ? (
        <DataTable
          columns={[
            { key: 'vendor', label: 'Vendor' },
            { key: 'seats', label: 'Seats', align: 'right' },
            { key: 'seat', label: 'Subscription /mo', align: 'right' },
            { key: 'seatChange', label: 'Seat change', align: 'right' },
            { key: 'overage', label: 'Budget overage', align: 'right' },
            { key: 'total', label: 'Total', align: 'right' },
          ]}
          rows={displayVendors.map((r) => ({
            vendor: (
              <Link
                href={vendorDetailHref(r.vendor, from, to)}
                className="text-accent hover:underline"
              >
                {vendorLabel(r.vendor)}
              </Link>
            ),
            seats: <SeatCountCell row={r} />,
            seat: usdPerMonth(r.seat_usd),
            seatChange: <SeatChangeCell row={r} />,
            overage: usd(r.budget_overage_usd),
            total: usd(r.seat_usd + r.budget_overage_usd),
          }))}
          footerRows={[
            {
              vendor: (
                <span className="text-xs uppercase tracking-wide text-muted">Grand total</span>
              ),
              seats: '—',
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

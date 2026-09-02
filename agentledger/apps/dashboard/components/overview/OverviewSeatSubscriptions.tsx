import Link from 'next/link';
import { vendorLabel } from '@/lib/fixed-cost-catalog';
import { formatSignedUsd, monthLabel } from '@/lib/seat-price-delta';
import { usdPerMonth } from '@/lib/usd-per-month';
import { usd } from '@/components/ui';

export type OverviewVendorSeatRow = {
  vendor: string;
  seat_usd: number;
  seats?: number;
  usd_from_seats?: number;
  prior_seats?: number | null;
  billing_month?: string;
};

type Props = {
  vendors: OverviewVendorSeatRow[];
  seatChangeUsd?: number;
  billingMonth?: string;
};

/** Per-vendor seat subscriptions at the top of Overview (same data as admin fixed overhead). */
export function OverviewSeatSubscriptions({ vendors, seatChangeUsd = 0, billingMonth }: Props) {
  const seatVendors = vendors.filter((v) => v.seat_usd > 0);
  if (seatVendors.length === 0) {
    return (
      <div className="mb-6 rounded-xl border border-dashed border-edge bg-panel/40 px-4 py-5 text-sm text-muted">
        No seat subscriptions in this period.{' '}
        <Link href="/admin/fixed-overhead" className="text-accent hover:underline">
          Add seats in admin
        </Link>
      </div>
    );
  }

  return (
    <div className="mb-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">
          Seat subscriptions · {billingMonth ? monthLabel(`${billingMonth}-01`) : 'monthly'} (seats
          × unit)
        </p>
        {seatChangeUsd !== 0 && (
          <p className={`text-xs ${seatChangeUsd > 0 ? 'text-warn' : 'text-pos'}`}>
            {formatSignedUsd(seatChangeUsd)} from seat changes vs prior month
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        {seatVendors.map((v) => {
          const seatDelta =
            v.prior_seats != null && v.seats != null && v.seats !== v.prior_seats
              ? v.seats - v.prior_seats
              : null;
          return (
            <Link
              key={v.vendor}
              href="/admin/fixed-overhead"
              className="min-w-[9rem] rounded-lg border border-edge bg-panel px-4 py-3 transition-colors hover:border-accent/40 hover:bg-white/[0.03]"
            >
              <p className="text-xs text-muted">{vendorLabel(v.vendor)}</p>
              <p className="num text-lg font-semibold text-gray-100">{usdPerMonth(v.seat_usd)}</p>
              <p className="mt-0.5 text-xs text-muted">
                {v.seats != null && v.seats > 0 ? (
                  <>
                    {v.seats} seat{v.seats === 1 ? '' : 's'}
                    {seatDelta != null && seatDelta !== 0 && (
                      <span className={seatDelta > 0 ? ' text-warn' : ' text-pos'}>
                        {' '}
                        ({seatDelta > 0 ? '+' : ''}
                        {seatDelta})
                      </span>
                    )}
                  </>
                ) : (
                  'monthly'
                )}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

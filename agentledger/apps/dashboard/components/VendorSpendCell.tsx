import { usd } from './ui';

/** Two-line vendor cell: seat + overage. */
export function VendorSpendCell({ slice }: { slice?: { seat_usd: number; overage_usd: number; total_usd: number } }) {
  if (!slice || slice.total_usd <= 0) {return <>—</>;}
  return (
    <div className="space-y-0.5 text-right text-xs leading-tight">
      {slice.seat_usd > 0 && (
        <div className="text-muted">
          Seat <span className="num text-gray-300">{usd(slice.seat_usd)}</span>
        </div>
      )}
      {slice.overage_usd > 0 && (
        <div>
          Overage <span className="num text-gray-100">{usd(slice.overage_usd)}</span>
        </div>
      )}
      {slice.seat_usd <= 0 && slice.overage_usd <= 0 && (
        <span className="num text-gray-300">{usd(slice.total_usd)}</span>
      )}
    </div>
  );
}

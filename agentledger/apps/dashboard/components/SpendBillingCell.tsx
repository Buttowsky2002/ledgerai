import { usd } from './ui';

/** Per-user spend split: usage-metered vs seat-license allocation. */
export function SpendBillingCell({
  meteredUsd,
  seatUsd,
  portalUsd,
  connectorUsd,
}: {
  meteredUsd?: number | string;
  seatUsd?: number | string;
  portalUsd?: number | string;
  connectorUsd?: number | string;
}) {
  const metered = Number(meteredUsd ?? 0);
  const seat = Number(seatUsd ?? 0);
  const portal = Number(portalUsd ?? 0);
  const connector = Number(connectorUsd ?? 0);

  if (metered <= 0 && seat <= 0) {
    return <span className="text-xs text-muted">—</span>;
  }

  const showMeteredProvenance =
    metered > 0 && portal > 0 && connector > 0 && Math.abs(portal + connector - metered) > 0.01;

  return (
    <span className="text-[11px] leading-snug text-muted">
      {metered > 0 ? (
        <span className="block">
          <span className="font-medium text-gray-300">Metered</span> {usd(metered)}
          {showMeteredProvenance ? (
            <span className="mt-0.5 block pl-2 text-[10px] opacity-90">
              {portal > 0 ? <span className="block">Import {usd(portal)}</span> : null}
              {connector > 0 ? <span className="block">Connector {usd(connector)}</span> : null}
            </span>
          ) : null}
        </span>
      ) : null}
      {seat > 0 ? (
        <span className="block">
          <span className="font-medium text-gray-300">Per seat</span> {usd(seat)}
        </span>
      ) : null}
    </span>
  );
}

export function billingTypeLabel(meteredUsd: number, seatUsd: number): 'metered' | 'per_seat' | 'mixed' | null {
  if (meteredUsd <= 0 && seatUsd <= 0) return null;
  if (meteredUsd > 0 && seatUsd > 0) return 'mixed';
  if (seatUsd > 0) return 'per_seat';
  return 'metered';
}

export function BillingTypeBadge({
  meteredUsd,
  seatUsd,
}: {
  meteredUsd?: number | string;
  seatUsd?: number | string;
}) {
  const kind = billingTypeLabel(Number(meteredUsd ?? 0), Number(seatUsd ?? 0));
  if (!kind) return null;
  const label = kind === 'mixed' ? 'Mixed' : kind === 'per_seat' ? 'Per seat' : 'Metered';
  const tone =
    kind === 'per_seat'
      ? 'border-info/40 bg-info/10 text-info'
      : kind === 'mixed'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : 'border-accent/40 bg-accent/10 text-accent';
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {label}
    </span>
  );
}

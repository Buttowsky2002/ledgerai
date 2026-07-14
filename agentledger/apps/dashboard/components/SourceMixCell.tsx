import { usd } from './ui';

export function SourceMixCell({
  portalUsd,
  connectorUsd,
}: {
  portalUsd?: number | string;
  connectorUsd?: number | string;
}) {
  const portal = Number(portalUsd ?? 0);
  const connector = Number(connectorUsd ?? 0);
  if (portal <= 0 && connector <= 0) {
    return <span className="text-xs text-muted">—</span>;
  }
  return (
    <span className="text-[11px] leading-snug text-muted">
      {portal > 0 ? <span className="block">Import {usd(portal)}</span> : null}
      {connector > 0 ? <span className="block">Connector {usd(connector)}</span> : null}
    </span>
  );
}

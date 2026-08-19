'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Card } from '@/components/ui';
import { fetchProductWorth } from '@/lib/api/lari';
import type { ProductWorthResponse } from '@/types/lari';

const SOURCE_LABEL: Record<string, string> = {
  portal_import: 'Portal CSV',
  connector: 'API connector',
  live: 'Live telemetry',
};

export function ImportCoverageBanner({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<ProductWorthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProductWorth({ startDate: from, endDate: to })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  if (!data?.importParityMessage) return null;

  const cov = data.dataCoverage;
  const healthy = cov.outcomeRoiReady && cov.productsWithoutOutcomes === 0;

  return (
    <Card
      title="Data coverage"
      subtitle="Import & outcome linkage"
      actions={
        <Badge tone={healthy ? 'pos' : 'warn'}>
          {cov.roiLinkedOutcomes}/{cov.totalOutcomes || '—'} outcomes in ROI
        </Badge>
      }
    >
      <p className="mb-3 text-sm text-muted">{data.importParityMessage}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {cov.portalImportSharePct > 0 && (
          <Badge tone="neutral">{cov.portalImportSharePct}% portal CSV</Badge>
        )}
        {cov.connectorUsd > 0 && (
          <Badge tone="neutral">{SOURCE_LABEL.connector}</Badge>
        )}
        {cov.liveUsd > 0 && <Badge tone="neutral">{SOURCE_LABEL.live}</Badge>}
        {cov.portalImportRuns > 0 && (
          <Badge tone="neutral">{cov.portalImportRuns} CSV import{cov.portalImportRuns === 1 ? '' : 's'}</Badge>
        )}
        {cov.importOutcomes > 0 && (
          <Badge tone="info">{cov.importOutcomes} imported outcomes</Badge>
        )}
      </div>
      {data.outcomeSources.recommended.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-gray-300">Recommended outcome sources</p>
          {data.outcomeSources.recommended.map((s) => (
            <div key={s.id} className="flex items-start gap-3 rounded-lg border border-edge bg-panel/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-200">{s.label}</p>
                <p className="text-xs text-muted">{s.reason}</p>
              </div>
              <Link href={s.href} className="shrink-0 text-xs text-accent hover:underline">
                Connect →
              </Link>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <Link href="/admin/billing" className="text-accent hover:underline">
          Import billing CSV
        </Link>
        <Link href="/settings/connectors" className="text-accent hover:underline">
          Manage connectors
        </Link>
      </div>
    </Card>
  );
}

'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DataCoveragePanel } from '../lari/ImportCoverageBanner';
import { Card, PageHeader } from '../../components/ui';
import { defaultRange } from '../../lib/auth';

function DataCoverageInner() {
  const searchParams = useSearchParams();
  const fromParam = searchParams.get('from')?.slice(0, 10);
  const toParam = searchParams.get('to')?.slice(0, 10);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const fallback = defaultRange(90);
  const from = fromParam && iso.test(fromParam) ? fromParam : fallback.from;
  const to = toParam && iso.test(toParam) ? toParam : fallback.to;

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Data coverage"
        subtitle="Connectors, billing imports, and outcome linkage for ROI analysis"
      />
      <DataCoveragePanel from={from} to={to} alwaysShow />
    </>
  );
}

export function DataCoverageClient() {
  return (
    <Suspense
      fallback={
        <Card title="Data coverage">
          <p className="py-8 text-center text-sm text-muted">Loading…</p>
        </Card>
      }
    >
      <DataCoverageInner />
    </Suspense>
  );
}

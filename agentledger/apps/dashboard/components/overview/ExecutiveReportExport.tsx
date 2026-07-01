'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { resolveRange, type DateBounds } from '@/lib/date-range';

const BTN =
  'rounded-md bg-accent/15 px-3 py-1.5 text-sm text-accent ring-1 ring-inset ring-accent/30 transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_SECONDARY =
  'rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50';

type Format = 'pdf' | 'xlsx';

export function ExecutiveReportExport({
  from: fromFallback,
  to: toFallback,
  bounds,
}: {
  from: string;
  to: string;
  bounds: DateBounds;
}) {
  const searchParams = useSearchParams();
  const { from, to } = resolveRange(
    {
      from: searchParams.get('from') ?? fromFallback,
      to: searchParams.get('to') ?? toFallback,
      range: searchParams.get('range') ?? undefined,
    },
    bounds,
  );
  const [loading, setLoading] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: Format) {
    setLoading(format);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to, format });
      const res = await fetch(`/api/reports/executive?${qs.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(body?.message ?? body?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition');
      const match = cd?.match(/filename="([^"]+)"/);
      const ext = format === 'pdf' ? 'pdf' : 'xlsx';
      const filename = match?.[1] ?? `executive-report-${from}-${to}.${ext}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <button type="button" className={BTN} disabled={!!loading} onClick={() => download('pdf')}>
          {loading === 'pdf' ? 'Exporting…' : 'Export report (PDF)'}
        </button>
        <button type="button" className={BTN_SECONDARY} disabled={!!loading} onClick={() => download('xlsx')}>
          {loading === 'xlsx' ? '…' : 'XLSX'}
        </button>
      </div>
      <p className="text-[11px] text-muted">
        {from} → {to}
      </p>
      {error && <p className="text-xs text-neg">{error}</p>}
    </div>
  );
}

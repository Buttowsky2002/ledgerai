'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { encodeRange, presetRange, RANGE_COOKIE, rangeHref } from '../lib/date-range';

type Props = {
  basePath: string;
  from: string;
  to: string;
  extraParams?: Record<string, string | undefined>;
};

const PRESETS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const;

function writeRangeCookie(r: { from: string; to: string }) {
  document.cookie = `${RANGE_COOKIE}=${encodeRange(r)}; path=/; max-age=31536000; samesite=lax`;
}

export function DateRangeFilter({ basePath, from, to, extraParams }: Props) {
  const router = useRouter();
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    setCustomFrom(from);
    setCustomTo(to);
  }, [from, to]);

  const navigate = (r: { from: string; to: string }) => {
    writeRangeCookie(r);
    router.push(rangeHref(basePath, r.from, r.to, extraParams));
  };

  const applyCustom = () => {
    if (customFrom > customTo) {
      setCustomError('Start date must be on or before end date.');
      return;
    }
    setCustomError(null);
    navigate({ from: customFrom, to: customTo });
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => {
          const r = presetRange(p.days);
          const active = r.from === from && r.to === to;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => navigate(r)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                active ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30' : 'text-muted hover:bg-white/5'
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <input
          type="date"
          value={customFrom}
          onChange={(e) => {
            setCustomFrom(e.target.value);
            setCustomError(null);
          }}
          className="rounded-md border border-edge bg-panel px-2 py-1.5 text-sm text-muted"
          aria-label="From date"
        />
        <span className="text-xs text-muted">→</span>
        <input
          type="date"
          value={customTo}
          onChange={(e) => {
            setCustomTo(e.target.value);
            setCustomError(null);
          }}
          className="rounded-md border border-edge bg-panel px-2 py-1.5 text-sm text-muted"
          aria-label="To date"
        />
        <button
          type="button"
          onClick={applyCustom}
          className="rounded-md bg-accent/20 px-3 py-1.5 text-sm text-white ring-1 ring-inset ring-accent/30 hover:bg-accent/30"
        >
          Apply
        </button>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs text-muted">
          {from} → {to}
        </span>
        <span className="text-[11px] text-muted/80">Applies across all pages</span>
        {customError && <span className="text-[11px] text-neg">{customError}</span>}
      </div>
    </div>
  );
}

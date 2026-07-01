'use client';

import Link from 'next/link';
import { presetRange, rangeHref } from '../lib/date-range';

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

export function DateRangeFilter({ basePath, from, to, extraParams }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => {
        const r = presetRange(p.days);
        const active = r.from === from && r.to === to;
        return (
          <Link
            key={p.label}
            href={rangeHref(basePath, r.from, r.to, extraParams)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              active ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30' : 'text-muted hover:bg-white/5'
            }`}
          >
            {p.label}
          </Link>
        );
      })}
      <span className="text-xs text-muted">
        {from} → {to}
      </span>
    </div>
  );
}

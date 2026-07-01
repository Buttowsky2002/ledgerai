'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { allTimeHref, presetRange, rangeHref, todayIso } from '../lib/date-range';

type Props = {
  basePath: string;
  from: string;
  to: string;
  earliestDay: string;
  latestDay?: string;
  isAllTime?: boolean;
  extraParams?: Record<string, string | undefined>;
  /** Trigger label when closed. */
  label?: string;
};

const PRESETS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const;

function fmtRange(from: string, to: string): string {
  return `${from} → ${to}`;
}

export function DateRangePicker({
  basePath,
  from,
  to,
  earliestDay,
  latestDay = todayIso(),
  isAllTime = false,
  extraParams,
  label = 'Select date',
}: Props) {
  const router = useRouter();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  useEffect(() => {
    if (open) {
      setDraftFrom(from);
      setDraftTo(to);
    }
  }, [open, from, to]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (href: string) => {
    router.push(href);
    router.refresh();
    setOpen(false);
  };

  const navigate = (nextFrom: string, nextTo: string) => {
    go(rangeHref(basePath, nextFrom, nextTo, extraParams));
  };

  const navigateAllTime = () => {
    go(allTimeHref(basePath, extraParams));
  };

  const apply = () => {
    if (!draftFrom || !draftTo || draftFrom > draftTo) return;
    navigate(draftFrom, draftTo);
  };

  const inputClass =
    'w-full rounded-md border border-edge bg-black/40 px-3 py-2 text-sm text-gray-100 [color-scheme:dark] focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30';

  return (
    <div ref={rootRef} className="relative mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-edge bg-panel px-3 py-1.5 text-sm text-gray-100 shadow-card transition-colors hover:border-accent/40 hover:bg-white/[0.03]"
      >
        <span>{label}</span>
        {isAllTime && <span className="text-xs text-accent">All time</span>}
        <svg
          className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Date range"
          className="absolute left-0 top-full z-50 mt-2 w-[min(100vw-2rem,22rem)] rounded-xl border border-edge bg-panel p-4 shadow-card"
        >
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Date range</p>
          <p className="mb-3 text-sm text-gray-200">{fmtRange(draftFrom, draftTo)}</p>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">From</span>
              <input
                type="date"
                className={inputClass}
                value={draftFrom}
                min={earliestDay}
                max={draftTo || latestDay}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">To</span>
              <input
                type="date"
                className={inputClass}
                value={draftTo}
                min={draftFrom || earliestDay}
                max={latestDay}
                onChange={(e) => setDraftTo(e.target.value)}
              />
            </label>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const r = presetRange(p.days);
              const active = !isAllTime && r.from === from && r.to === to;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => navigate(r.from, r.to)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30'
                      : 'border border-edge text-muted hover:bg-white/5 hover:text-gray-100'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={navigateAllTime}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                isAllTime
                  ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30'
                  : 'border border-edge text-muted hover:bg-white/5 hover:text-gray-100'
              }`}
            >
              All time
            </button>
          </div>

          <p className="mb-3 text-[11px] leading-relaxed text-muted">
            All time spans from your first connection or imported spend ({earliestDay}) through today.
          </p>

          <div className="flex justify-end gap-2 border-t border-edge/70 pt-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-1.5 text-xs text-muted hover:text-gray-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!draftFrom || !draftTo || draftFrom > draftTo}
              className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent ring-1 ring-inset ring-accent/30 enabled:hover:bg-accent/30 disabled:opacity-40"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

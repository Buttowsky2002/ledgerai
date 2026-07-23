'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useId, useRef, useState } from 'react';
import { allTimeHref, encodeRange, presetRange, RANGE_COOKIE, rangeHref, todayIso } from '../lib/date-range';

function writeRangeCookie(r: { from: string; to: string }) {
  document.cookie = `${RANGE_COOKIE}=${encodeRange(r)}; path=/; max-age=31536000; samesite=lax`;
}

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
  const [draftAllTime, setDraftAllTime] = useState(isAllTime);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftFrom(from);
      setDraftTo(to);
      setDraftAllTime(isAllTime);
      setApplying(false);
    }
  }, [open, from, to, isAllTime]);

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

  const commit = (href: string, cookie?: { from: string; to: string }) => {
    setApplying(true);
    setOpen(false);
    if (cookie) writeRangeCookie(cookie);
    startTransition(() => {
      router.push(href);
      router.refresh();
    });
  };

  const selectPreset = (days: number) => {
    const r = presetRange(days);
    setDraftFrom(r.from);
    setDraftTo(r.to);
    setDraftAllTime(false);
  };

  const selectAllTime = () => {
    setDraftFrom(earliestDay);
    setDraftTo(latestDay);
    setDraftAllTime(true);
  };

  const apply = () => {
    if (!draftFrom || !draftTo || draftFrom > draftTo) return;
    if (draftAllTime) {
      commit(allTimeHref(basePath, extraParams));
      return;
    }
    commit(rangeHref(basePath, draftFrom, draftTo, extraParams), {
      from: draftFrom,
      to: draftTo,
    });
  };

  const draftValid = Boolean(draftFrom && draftTo && draftFrom <= draftTo);
  const draftUnchanged =
    draftAllTime === isAllTime &&
    draftFrom === from &&
    draftTo === to;

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
        {applying && <span className="text-xs text-muted">Updating…</span>}
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
          <p className="mb-3 text-sm text-gray-200">
            {draftAllTime ? (
              <>
                All time
                <span className="mt-0.5 block text-xs text-muted">{fmtRange(draftFrom, draftTo)}</span>
              </>
            ) : (
              fmtRange(draftFrom, draftTo)
            )}
          </p>

          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">From</span>
              <input
                type="date"
                className={inputClass}
                value={draftFrom}
                min={earliestDay}
                max={draftTo || latestDay}
                onChange={(e) => {
                  setDraftFrom(e.target.value);
                  setDraftAllTime(false);
                }}
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
                onChange={(e) => {
                  setDraftTo(e.target.value);
                  setDraftAllTime(false);
                }}
              />
            </label>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const r = presetRange(p.days);
              const active = !draftAllTime && r.from === draftFrom && r.to === draftTo;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => selectPreset(p.days)}
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
              onClick={selectAllTime}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                draftAllTime
                  ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30'
                  : 'border border-edge text-muted hover:bg-white/5 hover:text-gray-100'
              }`}
            >
              All time
            </button>
          </div>

          <p className="mb-3 text-[11px] leading-relaxed text-muted">
            All time spans from your first connection or imported spend ({earliestDay}) through today.
            Presets only update this draft — nothing reloads until you Apply.
          </p>

          <div className="flex items-center justify-between gap-2 border-t border-edge/70 pt-3">
            <p className="min-w-0 truncate text-[11px] text-muted">
              {draftValid
                ? draftAllTime
                  ? `Will apply: all time (${fmtRange(draftFrom, draftTo)})`
                  : `Will apply: ${fmtRange(draftFrom, draftTo)}`
                : 'Pick a valid from / to range'}
            </p>
            <div className="flex shrink-0 gap-2">
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
                disabled={!draftValid || draftUnchanged || applying}
                className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent ring-1 ring-inset ring-accent/30 enabled:hover:bg-accent/30 disabled:opacity-40"
              >
                {applying ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

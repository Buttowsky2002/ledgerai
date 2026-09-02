'use client';

import { usd } from './ui';

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#38bdf8', '#a78bfa'];

type Slice = { label: string; value: number; color: string };

function buildSlices(seat: number, overage: number): Slice[] {
  const slices: Slice[] = [];
  if (seat > 0) {
    slices.push({ label: 'Seat', value: seat, color: COLORS[0] });
  }
  if (overage > 0) {
    slices.push({ label: 'Overage', value: overage, color: COLORS[1] });
  }
  return slices;
}

function conicGradient(slices: Slice[], total: number): string {
  if (total <= 0 || slices.length === 0) {
    return 'conic-gradient(#374151 0deg 360deg)';
  }
  let deg = 0;
  const stops: string[] = [];
  for (const s of slices) {
    const span = (s.value / total) * 360;
    stops.push(`${s.color} ${deg}deg ${deg + span}deg`);
    deg += span;
  }
  return `conic-gradient(${stops.join(', ')})`;
}

/** Seat vs overage pie for user detail vendor tabs. */
export function VendorSpendPie({
  seatUsd,
  overageUsd,
  size = 140,
}: {
  seatUsd: number;
  overageUsd: number;
  size?: number;
}) {
  const total = seatUsd + overageUsd;
  const slices = buildSlices(seatUsd, overageUsd);

  if (total <= 0) {
    return (
      <div
        className="flex items-center justify-center rounded-full border border-edge bg-black/20 text-xs text-muted"
        style={{ width: size, height: size }}
      >
        No spend
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div
        className="relative shrink-0 rounded-full ring-1 ring-inset ring-edge"
        style={{
          width: size,
          height: size,
          background: conicGradient(slices, total),
        }}
        aria-hidden
      >
        <div className="absolute inset-[22%] flex items-center justify-center rounded-full bg-panel text-center">
          <span className="num text-sm font-semibold text-gray-100">{usd(total)}</span>
        </div>
      </div>
      <ul className="space-y-1 text-xs">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: s.color }}
            />
            <span className="text-muted">{s.label}</span>
            <span className="num text-gray-200">{usd(s.value)}</span>
            <span className="text-muted">({((s.value / total) * 100).toFixed(0)}%)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { FORECAST_HORIZONS, forecastHorizonLabel } from '@/lib/forecast-horizon';
import { rangeHref } from '@/lib/date-range';

type Props = {
  basePath: string;
  from: string;
  to: string;
  forecastDays: number;
  extraParams?: Record<string, string | undefined>;
};

/** Forecast projection window selector (1 week → 1 year). */
export function ForecastHorizonLinks({ basePath, from, to, forecastDays, extraParams }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {FORECAST_HORIZONS.map((h) => (
        <Link
          key={h.days}
          href={rangeHref(basePath, from, to, { ...extraParams, horizon: String(h.days) })}
          className={`rounded px-3 py-1.5 text-sm ${
            h.days === forecastDays ? 'bg-accent/20 text-white' : 'border border-edge text-muted hover:bg-white/5'
          }`}
        >
          {h.label}
        </Link>
      ))}
    </div>
  );
}

export function forecastContextLabel(forecastDays: number, observedPeriodDays: number): string {
  return `Project spend · ${forecastHorizonLabel(forecastDays)} forecast from ${observedPeriodDays}-day run rate`;
}

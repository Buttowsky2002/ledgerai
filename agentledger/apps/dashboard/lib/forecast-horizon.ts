/** Forecast projection windows for CFO / cost-per-outcome project spend. */
export const FORECAST_HORIZONS = [
  { days: 7, label: '1 week' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
] as const;

export type ForecastHorizonDays = (typeof FORECAST_HORIZONS)[number]['days'];

export const DEFAULT_FORECAST_DAYS: ForecastHorizonDays = 365;

export function parseForecastHorizon(raw: string | undefined): ForecastHorizonDays {
  const n = Number(raw);
  const match = FORECAST_HORIZONS.find((h) => h.days === n);
  return match?.days ?? DEFAULT_FORECAST_DAYS;
}

export function forecastHorizonLabel(days: number): string {
  return FORECAST_HORIZONS.find((h) => h.days === days)?.label ?? `${days} days`;
}

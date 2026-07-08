import { CostPerOutcomeView } from '../../components/cost-per-outcome/CostPerOutcomeView';
import { fetchDataBounds } from '../../lib/data-bounds';
import { parseForecastHorizon } from '../../lib/forecast-horizon';
import { resolvePageRange } from '../../lib/resolve-range';

import type { CostBasisMode } from '../../types/lari';

export const dynamic = 'force-dynamic';

const BASIS_OPTIONS = ['reconciled', 'computed', 'metered'] as const;
const DEFAULT_BASIS: CostBasisMode = 'reconciled';

export default async function CostPerOutcomePage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; range?: string; basis?: string; horizon?: string };
}) {
  const costBasis = BASIS_OPTIONS.includes(searchParams.basis as CostBasisMode)
    ? (searchParams.basis as CostBasisMode)
    : DEFAULT_BASIS;
  const forecastDays = parseForecastHorizon(searchParams.horizon);

  const dataBounds = await fetchDataBounds(searchParams);
  const { from, to, isAllTime } = resolvePageRange(searchParams, dataBounds, 365);

  return (
    <CostPerOutcomeView
      from={from}
      to={to}
      isAllTime={isAllTime}
      dataBounds={dataBounds}
      forecastDays={forecastDays}
      costBasis={costBasis}
    />
  );
}

import { CfoView } from '../../components/cfo/CfoView';
import { parseRange } from '../../lib/date-range';

export const dynamic = 'force-dynamic';

const LEVELS = [0, 0.3, 0.5, 0.7, 0.9] as const;
const DEFAULT_LEVEL = 0.5;

export default function CfoPage({
  searchParams,
}: {
  searchParams: { min?: string; from?: string; to?: string };
}) {
  const min = LEVELS.includes(Number(searchParams.min) as (typeof LEVELS)[number])
    ? Number(searchParams.min)
    : DEFAULT_LEVEL;
  const { from, to } = parseRange(searchParams, 365);

  return <CfoView from={from} to={to} minConfidence={min} />;
}

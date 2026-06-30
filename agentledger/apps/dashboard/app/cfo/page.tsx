import { CfoView } from '../../components/cfo/CfoView';
import { defaultRange } from '../../lib/auth';

export const dynamic = 'force-dynamic';

const LEVELS = [0, 0.3, 0.5, 0.7, 0.9] as const;
const DEFAULT_LEVEL = 0.5;

export default function CfoPage({ searchParams }: { searchParams: { min?: string } }) {
  const min = LEVELS.includes(Number(searchParams.min) as (typeof LEVELS)[number])
    ? Number(searchParams.min)
    : DEFAULT_LEVEL;
  const { from, to } = defaultRange(365);

  return <CfoView from={from} to={to} minConfidence={min} />;
}

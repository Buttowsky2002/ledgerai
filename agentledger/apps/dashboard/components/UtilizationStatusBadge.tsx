import { Badge } from '@/components/ui';

export type UtilizationStatus = 'active' | 'low_use' | 'inactive';

const TONE: Record<UtilizationStatus, 'pos' | 'warn' | 'neg'> = {
  active: 'pos',
  low_use: 'warn',
  inactive: 'neg',
};

const LABEL: Record<UtilizationStatus, string> = {
  active: 'active',
  low_use: 'low use',
  inactive: 'inactive',
};

/** Shared seat/usage status badge (LARI user-value + Copilot-style). */
export function UtilizationStatusBadge({ status }: { status: UtilizationStatus }) {
  return (
    <Badge tone={TONE[status]} dot>
      {LABEL[status]}
    </Badge>
  );
}

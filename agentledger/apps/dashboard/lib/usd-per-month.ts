import { usd } from '@/components/ui';

/** Format a monthly subscription run-rate for display. */
export function usdPerMonth(v: number): string {
  return `${usd(v)}/mo`;
}

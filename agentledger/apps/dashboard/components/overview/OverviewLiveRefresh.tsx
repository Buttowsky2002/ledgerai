'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const DEFAULT_INTERVAL_MS = 30_000;

type Props = {
  /** Poll interval in ms (default 30s). Set 0 to disable. */
  intervalMs?: number;
};

/** Re-fetch server-rendered overview metrics on a timer so spend stays current. */
export function OverviewLiveRefresh({ intervalMs = DEFAULT_INTERVAL_MS }: Props) {
  const router = useRouter();
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  useEffect(() => {
    if (intervalMs <= 0) return;
    setLastRefresh(new Date());
    const id = window.setInterval(() => {
      router.refresh();
      setLastRefresh(new Date());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [router, intervalMs]);

  // Tick the "Xs ago" label between refreshes.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  if (intervalMs <= 0) return null;

  const ago =
    lastRefresh == null
      ? 'syncing…'
      : `${Math.max(1, Math.round((Date.now() - lastRefresh.getTime()) / 1000))}s ago`;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted"
      title="Spend refreshes automatically while this page is open"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pos opacity-40" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-pos" />
      </span>
      Live · updated {ago}
    </span>
  );
}

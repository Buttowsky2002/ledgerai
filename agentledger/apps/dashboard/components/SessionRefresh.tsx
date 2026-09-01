'use client';

import { useEffect } from 'react';

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** Keep the access cookie fresh while the refresh cookie remains valid. */
export function SessionRefresh() {
  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      } catch {
        /* ignore — middleware will recover on next navigation */
      }
    }

    void refresh();
    const id = window.setInterval(() => {
      if (!cancelled) {void refresh();}
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return null;
}

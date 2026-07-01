'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const DISMISS_KEY = 'ledgerai_onboard_dismissed';

/**
 * First-run onboarding nudge for a brand-new tenant (no virtual keys yet). `show` is
 * computed server-side; dismissal is remembered client-side in localStorage so it
 * never reappears once the operator closes it.
 */
export function FirstRunBanner({ show }: { show: boolean }) {
  // Start hidden so a dismissed banner doesn't flash before hydration reads localStorage.
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === 'true');
  }, []);

  if (!show || dismissed) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start justify-between gap-4 rounded border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-gray-100"
    >
      <div>
        <p>
          <strong>Get started</strong> — Issue a virtual key in Settings → Virtual keys and point your AI SDK at
          https://app.yourdomain.com/v1. Visit Settings → Integrations to connect your IdP via SSO or SCIM.
        </p>
        <div className="mt-2 flex gap-3">
          <Link href="/settings?tab=keys" className="text-accent hover:underline">
            Go to Settings
          </Link>
          <Link href="/settings?tab=integrations" className="text-accent hover:underline">
            Set up SSO
          </Link>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-muted hover:text-white"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, 'true');
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}

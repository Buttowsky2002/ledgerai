'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function PrivacySettings({
  initialIndividualAnalytics,
  initialComplianceFlags,
}: {
  initialIndividualAnalytics: boolean;
  initialComplianceFlags: Record<string, unknown>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialIndividualAnalytics);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    setErr(null);
    const res = await fetch('/api/tenant', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        complianceFlags: {
          ...initialComplianceFlags,
          perUserAnalytics: next ? 'individual' : 'team',
        },
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(`Save failed (${res.status})`);
      return;
    }
    setEnabled(next);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-xl">
        <p className="text-sm text-gray-100">Individual-level usage analytics</p>
        <p className="mt-1 text-xs text-muted">
          Off by default; when off, LARI reports seat and usage findings at team/plan level only.
          Enabling shows per-user utilization rows in the CFO view — a license optimization proxy,
          not a measure of individual output or business value.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy}
          onClick={toggle}
          className={`relative h-7 w-12 rounded-full transition-colors ${
            enabled ? 'bg-accent/60' : 'bg-edge'
          } disabled:opacity-50`}
        >
          <span
            className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span className="text-sm text-muted">{enabled ? 'Individual' : 'Team'}</span>
        {busy && <span className="text-xs text-muted">Saving…</span>}
      </div>
      {err && <p className="w-full text-xs text-neg">{err}</p>}
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { isDevMode, loginUrl } from '@/lib/auth';

export type SessionInfo = {
  userId: string;
  tenantId: string;
  role: string;
} | null;

const BTN =
  'rounded border border-edge bg-panel px-4 py-2 text-sm text-gray-100 hover:bg-white/5 disabled:opacity-50';
const BTN_ACCENT = 'rounded bg-accent/20 px-4 py-2 text-sm text-white hover:bg-accent/30 disabled:opacity-50';

export function AccountSettings({ session }: { session: SessionInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const signedIn = Boolean(session?.userId);

  async function logout() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok && res.status !== 204) {
        setErr(`Sign out failed (${res.status})`);
        setBusy(false);
        return;
      }
      window.location.href = '/login';
    } catch {
      setErr('Sign out failed');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-gray-100">Session</p>
        {signedIn ? (
          <dl className="mt-2 grid gap-1 text-sm text-muted sm:grid-cols-[8rem_1fr]">
            <dt>User id</dt>
            <dd className="font-mono text-xs text-gray-100">{session!.userId}</dd>
            <dt>API role</dt>
            <dd className="capitalize text-gray-100">{session!.role}</dd>
            <dt>Tenant</dt>
            <dd className="font-mono text-xs text-gray-100">{session!.tenantId}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {isDevMode()
              ? 'No SSO session — this stack is using the dev tenant header. Sign in below to attach a real identity.'
              : 'Not signed in.'}
          </p>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm text-gray-100">{signedIn ? 'Switch account' : 'Sign in'}</p>
        <div className="flex flex-wrap gap-2">
          <a href={loginUrl('google')} className={BTN}>
            Continue with Google
          </a>
          <a href={loginUrl('microsoft')} className={BTN}>
            Continue with Microsoft
          </a>
        </div>
      </div>

      {signedIn && (
        <div>
          <button type="button" className={BTN_ACCENT} disabled={busy} onClick={logout}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          {err && <p className="mt-2 text-xs text-neg">{err}</p>}
        </div>
      )}

      {!signedIn && !isDevMode() && (
        <button
          type="button"
          className={BTN}
          onClick={() => {
            router.push('/login');
          }}
        >
          Open login page
        </button>
      )}
    </div>
  );
}

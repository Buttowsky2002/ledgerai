'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useState } from 'react';

type InviteDetails = {
  inviteId: string;
  email: string;
  apiRole: string;
  expiresAt: string;
};

const ROLE_LABELS: Record<string, string> = {
  viewer: 'Viewer — read-only access to dashboards and reports',
  analyst: 'Analyst — can run queries and modify attribution rules',
  admin: 'Admin — full access including user management',
};

function AcceptInviteForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const router = useRouter();

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'submitting' | 'done' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('No invite token found in the link. Please check your email and try again.');
      setState('error');
      return;
    }
    fetch(`/api/invites/accept?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string;
            detail?: string;
          };
          throw new Error(
            body.detail ?? body.message ?? 'Invite not found, already used, or expired.',
          );
        }
        return res.json() as Promise<InviteDetails>;
      })
      .then((data) => {
        setInvite(data);
        setState('ready');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to validate invite.');
        setState('error');
      });
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (state !== 'ready') {return;}
    setState('submitting');
    setError(null);

    try {
      const res = await fetch('/api/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName: displayName.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          detail?: string;
        };
        throw new Error(body.detail ?? body.message ?? 'Failed to accept invite.');
      }
      setState('done');
      setTimeout(() => router.push('/login'), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred.');
      setState('ready');
    }
  }

  return (
    <div className="mx-auto max-w-md py-16 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-white">
          Badger<span className="text-accent">IQ</span>
        </h1>
        <p className="mt-1 text-sm text-muted">AI spend management</p>
      </div>

      {state === 'loading' && (
        <p className="animate-pulse text-sm text-muted">Validating your invite…</p>
      )}

      {state === 'error' && (
        <div className="rounded-md border border-neg/40 bg-neg/10 p-4">
          <p className="text-sm text-neg">{error}</p>
          <a href="/login" className="mt-3 block text-sm text-accent hover:underline">
            Back to sign in
          </a>
        </div>
      )}

      {(state === 'ready' || state === 'submitting') && invite && (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <h2 className="text-xl font-semibold text-white">You have been invited</h2>
            <p className="mt-1 text-sm text-muted">Set up your profile to get started with BadgerIQ.</p>
          </div>

          <div className="space-y-2 rounded-md border border-edge bg-panel p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Email</span>
              <span className="font-mono text-white">{invite.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Access level</span>
              <span className="capitalize text-accent">{invite.apiRole}</span>
            </div>
            <p className="border-t border-edge pt-1 text-xs text-muted">
              {ROLE_LABELS[invite.apiRole] ?? invite.apiRole}
            </p>
          </div>

          <label className="block space-y-1">
            <span className="text-sm text-muted">
              Your name <span className="text-muted">(optional — shown in the dashboard)</span>
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Alex Kim"
              className="w-full rounded-md border border-edge bg-ink px-3 py-2 text-sm text-white placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>

          {error && <p className="text-sm text-neg">{error}</p>}

          <button
            type="submit"
            disabled={state === 'submitting'}
            className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
          >
            {state === 'submitting' ? 'Accepting invite…' : 'Accept invite & sign in'}
          </button>

          <p className="text-center text-xs text-muted">
            You will be redirected to sign in with Google or Microsoft after accepting.
          </p>
        </form>
      )}

      {state === 'done' && (
        <div className="rounded-md border border-pos/40 bg-pos/10 p-4 text-center">
          <p className="text-sm font-medium text-pos">Invite accepted!</p>
          <p className="mt-1 text-xs text-muted">Redirecting you to sign in…</p>
        </div>
      )}
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<p className="p-16 text-sm text-muted animate-pulse">Loading invite…</p>}>
      <AcceptInviteForm />
    </Suspense>
  );
}

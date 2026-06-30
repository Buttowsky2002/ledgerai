'use client';

import { useState } from 'react';
import { testCopilotToken } from '@/lib/api/github-copilot';

const PERMISSIONS_HELP = (
  <>
    Use a fine-grained organization PAT with read-only:{' '}
    <strong>Organization Copilot metrics</strong>, <strong>GitHub Copilot Business</strong>, and{' '}
    <strong>Members</strong>. Classic PAT fallback: <code className="text-xs">read:org</code> +{' '}
    <code className="text-xs">manage_billing:copilot</code>. The token is encrypted at rest and never logged.
  </>
);

export function GitHubCopilotConnectForm({
  onConnected,
  compact = false,
}: {
  onConnected?: () => void;
  compact?: boolean;
}) {
  const [displayName, setDisplayName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [enterpriseSlug, setEnterpriseSlug] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; orgName?: string; hint?: string } | null>(
    null,
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canTest = orgSlug.trim().length > 0 && githubToken.trim().length > 0;
  const canConnect = displayName.trim().length > 0 && canTest;

  async function handleTest() {
    if (!canTest) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    setSuccess(null);
    const result = await testCopilotToken(githubToken.trim(), orgSlug.trim().toLowerCase());
    setTesting(false);
    setTestResult(result);
    if (!result.ok) {
      setError(result.hint ?? 'Token validation failed. Check organization permissions.');
    }
  }

  async function handleConnect() {
    if (!canConnect) return;
    setConnecting(true);
    setError(null);
    setSuccess(null);

    const res = await fetch('/api/github-copilot/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: displayName.trim(),
        orgSlug: orgSlug.trim().toLowerCase(),
        githubToken: githubToken.trim(),
        enterpriseSlug: enterpriseSlug.trim() || undefined,
      }),
    });

    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    setConnecting(false);

    if (!res.ok) {
      const hint =
        (typeof data?.hint === 'string' && data.hint) ||
        (data?.message && typeof data.message === 'object'
          ? String((data.message as Record<string, unknown>).hint ?? (data.message as Record<string, unknown>).message ?? '')
          : '') ||
        (typeof data?.message === 'string' ? data.message : '') ||
        'Could not create Copilot connection.';
      setError(hint || `Request failed (${res.status})`);
      return;
    }

    setSuccess('Connection created. Initial sync started — data will appear in Overview shortly.');
    setGithubToken('');
    onConnected?.();
  }

  return (
    <div className={compact ? 'space-y-4' : 'grid gap-4 md:grid-cols-2'}>
      {!compact && (
        <p className="md:col-span-2 text-sm text-muted">{PERMISSIONS_HELP}</p>
      )}

      <label className="block text-sm">
        <span className="text-muted">Connection name</span>
        <input
          className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Acme Copilot"
        />
      </label>

      <label className="block text-sm">
        <span className="text-muted">GitHub organization slug</span>
        <input
          className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
          value={orgSlug}
          onChange={(e) => {
            setOrgSlug(e.target.value);
            setTestResult(null);
          }}
          placeholder="acme-corp"
          autoComplete="off"
        />
      </label>

      <label className="block text-sm">
        <span className="text-muted">Enterprise slug (optional)</span>
        <input
          className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
          value={enterpriseSlug}
          onChange={(e) => setEnterpriseSlug(e.target.value)}
          placeholder="Leave blank for org-level Copilot Business"
          autoComplete="off"
        />
      </label>

      <label className={`block text-sm ${compact ? '' : 'md:col-span-2'}`}>
        <span className="text-muted">GitHub fine-grained PAT</span>
        <input
          type="password"
          className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
          value={githubToken}
          onChange={(e) => {
            setGithubToken(e.target.value);
            setTestResult(null);
          }}
          placeholder="github_pat_…"
          autoComplete="new-password"
        />
        {compact && <p className="mt-2 text-xs text-muted">{PERMISSIONS_HELP}</p>}
      </label>

      {testResult?.ok && (
        <p className={`text-sm text-pos ${compact ? '' : 'md:col-span-2'}`}>
          Token valid for {testResult.orgName ?? orgSlug}.
        </p>
      )}

      {error && (
        <p className={`rounded border border-neg/30 bg-neg/10 px-3 py-2 text-sm text-neg ${compact ? '' : 'md:col-span-2'}`}>
          {error}
        </p>
      )}

      {success && (
        <p className={`rounded border border-pos/30 bg-pos/10 px-3 py-2 text-sm text-pos ${compact ? '' : 'md:col-span-2'}`}>
          {success}
        </p>
      )}

      <div className={`flex flex-wrap gap-2 ${compact ? '' : 'md:col-span-2'}`}>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!canTest || testing}
          className="rounded border border-edge px-4 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test token'}
        </button>
        <button
          type="button"
          onClick={() => void handleConnect()}
          disabled={!canConnect || connecting}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {connecting ? 'Connecting…' : 'Connect Copilot'}
        </button>
      </div>
    </div>
  );
}

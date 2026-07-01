'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, KeyboardEvent, useState } from 'react';

// Match the field/button styling used by settings/forms.tsx.
const FIELD =
  'rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 placeholder:text-muted focus:border-accent focus:outline-none';
const BTN = 'rounded bg-accent/20 px-3 py-1.5 text-sm text-white hover:bg-accent/30 disabled:opacity-50';

/** POST helper mirroring settings/forms.tsx useCreate(). */
function usePost(url: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function post(body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setErr(null);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(`Request failed (${res.status})`);
      return null;
    }
    router.refresh();
    return res.json().catch(() => ({}));
  }
  return { post, busy, err };
}

/** Revoke a SCIM token — same pattern as DeleteButton, but the API verb is POST. */
export function RevokeButton({ url, label = 'Revoke' }: { url: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(url, { method: 'POST' });
        setBusy(false);
        router.refresh();
      }}
      className="text-xs text-neg hover:text-neg/80 disabled:opacity-50"
    >
      {busy ? '…' : label}
    </button>
  );
}

/** Issue a SCIM bearer token; reveal the plaintext exactly once with a copy button. */
export function IssueScimTokenForm() {
  const { post, busy, err } = usePost('/api/scim-tokens');
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await post({ name });
    if (created && typeof created.token === 'string') {
      setToken(created.token);
      setName('');
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <input
        className={FIELD}
        placeholder="Token name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button className={BTN} disabled={busy}>
        Issue token
      </button>
      {err && <span className="text-xs text-neg">{err}</span>}
      {token && (
        <div className="mt-2 w-full rounded border border-accent/40 bg-accent/10 p-2 text-xs">
          <div className="mb-1 text-amber-300">Copy now — this token will not be shown again.</div>
          <div className="flex items-center gap-2">
            <code className="break-all text-accent">{token}</code>
            <button
              type="button"
              className="shrink-0 rounded border border-edge px-2 py-0.5 text-muted hover:bg-white/5"
              onClick={() => {
                void navigator.clipboard?.writeText(token);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

/** Add a per-tenant OIDC IdP. Email domains use a chip-style tag input (no library). */
export function AddIdpForm() {
  const { post, busy, err } = usePost('/api/tenant-idp-config');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecretRef, setClientSecretRef] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [domainDraft, setDomainDraft] = useState('');
  const [jitEnabled, setJit] = useState(true);
  const [defaultApiRole, setRole] = useState('viewer');

  function commitDomain() {
    const d = domainDraft.trim().toLowerCase().replace(/,$/, '');
    if (d && !domains.includes(d)) setDomains([...domains, d]);
    setDomainDraft('');
  }
  function onDomainKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDomain();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Fold any half-typed domain still in the input into the list before submitting.
    const emailDomains = [...domains];
    const pending = domainDraft.trim().toLowerCase().replace(/,$/, '');
    if (pending && !emailDomains.includes(pending)) emailDomains.push(pending);
    const ok = await post({ issuer, clientId, clientSecretRef, emailDomains, jitEnabled, defaultApiRole });
    if (ok) {
      setIssuer('');
      setClientId('');
      setClientSecretRef('');
      setDomains([]);
      setDomainDraft('');
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <input
          className={FIELD}
          placeholder="Issuer URL"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          required
        />
        <input
          className={FIELD}
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
        />
      </div>
      <div>
        <input
          className={`${FIELD} w-full max-w-sm`}
          placeholder="e.g. ACME_OIDC_SECRET"
          value={clientSecretRef}
          onChange={(e) => setClientSecretRef(e.target.value)}
          required
        />
        <p className="mt-1 text-xs text-muted">
          Set this env var on the API container. The secret is never stored here.
        </p>
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          {domains.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-xs text-gray-100"
            >
              {d}
              <button
                type="button"
                className="text-muted hover:text-neg"
                onClick={() => setDomains(domains.filter((x) => x !== d))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className={FIELD}
            placeholder="Email domains (Enter to add)"
            value={domainDraft}
            onChange={(e) => setDomainDraft(e.target.value)}
            onKeyDown={onDomainKey}
            onBlur={commitDomain}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-sm text-gray-100">
          <input type="checkbox" checked={jitEnabled} onChange={(e) => setJit(e.target.checked)} />
          JIT provisioning
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-100">
          Default role
          <select className={FIELD} value={defaultApiRole} onChange={(e) => setRole(e.target.value)}>
            {['viewer', 'analyst', 'admin'].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button className={BTN} disabled={busy}>
          Add IdP
        </button>
        {err && <span className="text-xs text-neg">{err}</span>}
      </div>
    </form>
  );
}

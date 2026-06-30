'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';

const FIELD =
  'rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 placeholder:text-muted focus:border-accent focus:outline-none';
const BTN = 'rounded bg-accent/20 px-3 py-1.5 text-sm text-white hover:bg-accent/30 disabled:opacity-50';

function useCreate(url: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function post(body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setErr(null);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(`Request failed (${res.status})`);
      return null;
    }
    router.refresh();
    return res.json().catch(() => ({}));
  }
  return { post, busy, err, router };
}

export function CreateKey() {
  const { post, busy, err } = useCreate('/api/keys');
  const [name, setName] = useState('');
  const [environment, setEnv] = useState('prod');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await post({ name, environment });
    if (created && typeof created.key === 'string') {
      setPlaintext(created.key);
      setName('');
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <input className={FIELD} placeholder="Key name" value={name} onChange={(e) => setName(e.target.value)} required />
      <input className={FIELD} placeholder="environment" value={environment} onChange={(e) => setEnv(e.target.value)} />
      <button className={BTN} disabled={busy}>Create key</button>
      {err && <span className="text-xs text-red-400">{err}</span>}
      {plaintext && (
        <div className="mt-2 w-full rounded border border-accent/40 bg-accent/10 p-2 text-xs">
          Copy now — shown once: <code className="break-all text-accent">{plaintext}</code>
        </div>
      )}
    </form>
  );
}

export function CreatePolicy() {
  const { post, busy, err } = useCreate('/api/policies');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('dlp');
  const [action, setAction] = useState('block');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await post({ name, kind, action });
    if (ok) setName('');
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <input className={FIELD} placeholder="Policy name" value={name} onChange={(e) => setName(e.target.value)} required />
      <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value)}>
        {['dlp', 'budget', 'model_allow', 'approval'].map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <select className={FIELD} value={action} onChange={(e) => setAction(e.target.value)}>
        {['allow', 'log', 'warn', 'redact', 'block', 'ticket'].map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <button className={BTN} disabled={busy}>Create policy</button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </form>
  );
}

export function CreateBudget() {
  const { post, busy, err } = useCreate('/api/budgets');
  const [scopeType, setScopeType] = useState('tenant');
  const [scopeId, setScopeId] = useState('');
  const [amountUsd, setAmount] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await post({ scopeType, scopeId, amountUsd: Number(amountUsd) });
    if (ok) {
      setScopeId('');
      setAmount('');
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <select className={FIELD} value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
        {['tenant', 'app', 'agent', 'key', 'model'].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <input className={FIELD} placeholder="scope id" value={scopeId} onChange={(e) => setScopeId(e.target.value)} required />
      <input className={FIELD} type="number" step="0.01" placeholder="amount USD" value={amountUsd} onChange={(e) => setAmount(e.target.value)} required />
      <button className={BTN} disabled={busy}>Create budget</button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </form>
  );
}

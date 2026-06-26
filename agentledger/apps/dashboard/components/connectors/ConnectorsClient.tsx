'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, DataTable, PageHeader } from '../ui';

type Connector = {
  connectorId: string;
  displayName: string;
  provider: string;
  category: string;
  status: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
};

type Preset = {
  definitionId?: string;
  name: string;
  provider: string;
  category: string;
  builtIn?: boolean;
};

type PreviewResult = {
  ok: boolean;
  warning?: string;
  rawResponse: unknown;
  normalizedPreview: Record<string, unknown>[];
  suggestedMappings: { source: string; target: string; confidence: number }[];
  errors: { recordRef: string; code: string; message: string }[];
};

const CATEGORIES = [
  'provider_spend',
  'ai_usage',
  'coding_tool',
  'gateway_logs',
  'observability',
  'cloud_cost',
  'outcome_system',
  'risk_security',
  'custom',
] as const;

const AUTH_TYPES = ['api_key_header', 'bearer_token', 'basic_auth', 'custom_header', 'none'] as const;

const PRESET_DEFAULTS: Record<
  string,
  { baseUrl: string; authType: string; endpointPath: string; category: string }
> = {
  'anthropic-usage': {
    baseUrl: 'https://api.anthropic.com',
    authType: 'api_key_header',
    endpointPath: '/v1/organizations/analytics/cost/list_by_user',
    category: 'provider_spend',
  },
  'openai-usage': {
    baseUrl: 'https://api.openai.com',
    authType: 'api_key_header',
    endpointPath: '/v1/usage',
    category: 'provider_spend',
  },
};

function formatApiError(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.detail === 'string') return body.detail;
  if (typeof body.message === 'string') return body.message;
  if (body.message && typeof body.message === 'object' && !Array.isArray(body.message)) {
    const nested = body.message as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }
  if (Array.isArray(body.message)) {
    return body.message.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ');
  }
  if (typeof body.error === 'string') return body.error;
  return fallback;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultConnectorRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: isoDate(from), to: isoDate(to) };
}

export function ConnectorsClient() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rangeFrom, setRangeFrom] = useState(() => defaultConnectorRange().from);
  const [rangeTo, setRangeTo] = useState(() => defaultConnectorRange().to);

  const [form, setForm] = useState({
    displayName: '',
    presetId: 'generic-rest-spend',
    category: 'provider_spend',
    baseUrl: 'https://api.example.com',
    authType: 'bearer_token',
    authSecret: '',
    endpointPath: '/v1/spend',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [connRes, presetRes] = await Promise.all([
        fetch('/api/connectors'),
        fetch('/api/connector-definitions'),
      ]);
      if (connRes.ok) setConnectors(await connRes.json());
      if (presetRes.ok) setPresets(await presetRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const update = () => setCooldownSec(Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)));
    update();
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const createConnector = async () => {
    setError(null);
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: form.displayName,
        presetId: form.presetId,
        category: form.category,
        baseUrl: form.baseUrl,
        authSecret: form.authSecret || undefined,
        configJson: { endpointPath: form.endpointPath, authType: form.authType },
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(formatApiError(body, 'Failed to create connector'));
      return;
    }
    setFormOpen(false);
    setForm((f) => ({ ...f, authSecret: '', displayName: '' }));
    await load();
  };

  const startApiCooldown = () => {
    setCooldownUntil(Date.now() + 65_000);
  };

  const deleteConnector = async (id: string, name: string) => {
    if (!window.confirm(`Delete connector "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    setError(null);
    const res = await fetch(`/api/connectors/${id}`, { method: 'DELETE' });
    setDeleting(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(formatApiError(body, 'Delete failed'));
      return;
    }
    if (selectedId === id) {
      setSelectedId(null);
      setPreview(null);
    }
    await load();
  };

  const syncRangeBody = () => ({ from: rangeFrom, to: rangeTo });

  const applyRangePreset = (days: number) => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (days - 1));
    setRangeFrom(isoDate(from));
    setRangeTo(isoDate(to));
  };

  const testConnector = async (id: string) => {
    setSelectedId(id);
    setPreview(null);
    setError(null);
    const res = await fetch(`/api/connectors/${id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncRangeBody()),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(formatApiError(body, 'Test failed'));
      return;
    }
    const data = (await res.json()) as PreviewResult;
    setPreview(data);
    startApiCooldown();
    if (data.warning) {
      setError(data.warning);
    } else if (data.errors?.length) {
      setError(data.errors.map((e) => `${e.recordRef}: ${e.message}`).join('; '));
    }
  };

  const syncConnector = async (id: string) => {
    if (cooldownSec > 0) {
      setError(`Wait ${cooldownSec}s after Test before syncing (Anthropic rate limits).`);
      return;
    }
    setSyncing(id);
    setError(null);
    const res = await fetch(`/api/connectors/${id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncRangeBody()),
    });
    setSyncing(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(formatApiError(body, 'Sync failed'));
      return;
    }
    const body = (await res.json()) as {
      recordsImported?: number;
      recordsSeen?: number;
      emptyWarning?: string;
      duplicateWarning?: string;
    };
    if (body.emptyWarning) {
      setError(String(body.emptyWarning));
    } else if (body.duplicateWarning) {
      setError(String(body.duplicateWarning));
    } else if ((body.recordsImported ?? 0) > 0) {
      setError(null);
    } else {
      setError(`Sync completed but imported 0 rows (${body.recordsSeen ?? 0} seen). Check Test preview for API data.`);
    }
    startApiCooldown();
    await load();
  };

  const statusTone = (s: string) => {
    if (s === 'healthy' || s === 'connected') return 'text-pos';
    if (s === 'auth_failed' || s === 'validation_failed') return 'text-neg';
    if (s === 'syncing' || s === 'rate_limited') return 'text-warn';
    return 'text-muted';
  };

  return (
    <>
      <PageHeader
        title="Data Sources"
        subtitle="Connect external APIs to ingest spend, usage, outcomes, and risk data."
        eyebrow="Settings"
        actions={
          <div className="flex gap-2">
            <Link href="/settings" className="rounded border border-edge px-3 py-1.5 text-sm text-muted hover:bg-white/5">
              Back to settings
            </Link>
            <button
              type="button"
              onClick={() => setFormOpen(!formOpen)}
              className="rounded bg-accent/20 px-3 py-1.5 text-sm text-white hover:bg-accent/30"
            >
              {formOpen ? 'Cancel' : 'Add API connector'}
            </button>
          </div>
        }
      />

      {error && (
        <div
          className={`mb-4 rounded border px-4 py-2 text-sm ${
            error.includes('no cost rows') || error.includes('imported 0 rows')
              ? 'border-warn/40 bg-warn/10 text-warn'
              : 'border-neg/40 bg-neg/10 text-neg'
          }`}
        >
          {error}
        </div>
      )}

      {formOpen && (
        <Card title="Custom API Connector">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-muted">Name</span>
              <input
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="My spend API"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Preset template</span>
              <select
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.presetId}
                onChange={(e) => {
                  const presetId = e.target.value;
                  const defaults = PRESET_DEFAULTS[presetId];
                  setForm({ ...form, presetId, ...(defaults ?? {}) });
                }}
              >
                {presets.filter((p) => p.builtIn !== false).map((p) => (
                  <option key={p.definitionId ?? p.name} value={p.definitionId ?? p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              {form.presetId === 'anthropic-usage' && (
                <p className="mt-1 text-xs text-muted">
                  Requires an Anthropic Admin API key (sk-ant-admin). Imports per-user spend (user_id, email) when
                  available; falls back to org cost report otherwise. Max 31-day window per sync.
                </p>
              )}
            </label>
            <label className="block text-sm">
              <span className="text-muted">Category</span>
              <select
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-muted">Base URL</span>
              <input
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Endpoint path</span>
              <input
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.endpointPath}
                onChange={(e) => setForm({ ...form, endpointPath: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Auth type</span>
              <select
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.authType}
                onChange={(e) => setForm({ ...form, authType: e.target.value })}
              >
                {AUTH_TYPES.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm md:col-span-2">
              <span className="text-muted">Auth secret (stored encrypted, never logged)</span>
              <input
                type="password"
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.authSecret}
                onChange={(e) => setForm({ ...form, authSecret: e.target.value })}
                placeholder="API key or bearer token"
              />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void createConnector()}
              disabled={!form.displayName}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Save connector
            </button>
          </div>
        </Card>
      )}

      <Card title="Sync time frame" subtitle="Applies to Test and Sync now (max 31 days for Anthropic)">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex gap-2">
            {[7, 14, 30].map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => applyRangePreset(days)}
                className="rounded border border-edge px-3 py-1.5 text-xs text-muted hover:bg-white/5"
              >
                Last {days}d
              </button>
            ))}
          </div>
          <label className="block text-sm">
            <span className="text-muted">From</span>
            <input
              type="date"
              className="mt-1 block rounded border border-edge bg-black/20 px-3 py-2"
              value={rangeFrom}
              max={rangeTo}
              onChange={(e) => setRangeFrom(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">To</span>
            <input
              type="date"
              className="mt-1 block rounded border border-edge bg-black/20 px-3 py-2"
              value={rangeTo}
              min={rangeFrom}
              max={isoDate(new Date())}
              onChange={(e) => setRangeTo(e.target.value)}
            />
          </label>
        </div>
      </Card>

      <Card title="API Connectors">
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <DataTable
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'provider', label: 'Provider' },
              { key: 'category', label: 'Category' },
              { key: 'status', label: 'Status' },
              { key: 'lastSync', label: 'Last sync' },
              { key: 'actions', label: '' },
            ]}
            rows={connectors.map((c) => ({
              name: c.displayName ?? c.connectorId,
              provider: c.provider ?? '—',
              category: c.category ?? '—',
              status: <span className={statusTone(c.status)}>{c.status}</span>,
              lastSync: c.lastSuccessAt ? new Date(c.lastSuccessAt).toLocaleString() : '—',
              actions: (
                <div className="flex gap-2">
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => void testConnector(c.connectorId)}>
                    Test
                  </button>
                  <button
                    type="button"
                    className="text-xs text-accent hover:underline disabled:opacity-50"
                    disabled={syncing === c.connectorId || cooldownSec > 0}
                    onClick={() => void syncConnector(c.connectorId)}
                  >
                    {syncing === c.connectorId ? 'Syncing…' : cooldownSec > 0 ? `Wait ${cooldownSec}s` : 'Sync now'}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-neg hover:underline disabled:opacity-50"
                    disabled={deleting === c.connectorId}
                    onClick={() => void deleteConnector(c.connectorId, c.displayName ?? c.connectorId)}
                  >
                    {deleting === c.connectorId ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              ),
            }))}
          />
        )}
      </Card>

      {preview && selectedId && (
        <Card title="Connection preview" subtitle="Sanitized response — secrets redacted">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Raw response (sanitized)</h3>
              <pre className="max-h-64 overflow-auto rounded border border-edge bg-black/30 p-3 text-xs">
                {JSON.stringify(preview.rawResponse, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Normalized preview</h3>
              <pre className="max-h-64 overflow-auto rounded border border-edge bg-black/30 p-3 text-xs">
                {JSON.stringify(preview.normalizedPreview, null, 2)}
              </pre>
            </div>
          </div>
          {preview.normalizedPreview.some((r) => r.user_id || r.user_email) && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Spend by user (preview)</h3>
              <DataTable
                columns={[
                  { key: 'user', label: 'User' },
                  { key: 'model', label: 'Model' },
                  { key: 'cost', label: 'Cost', align: 'right' },
                ]}
                rows={preview.normalizedPreview.map((r, i) => ({
                  user: String(r.user_email || r.user_id || '—'),
                  model: String(r.model ?? '—'),
                  cost: r.cost_usd != null ? `$${Number(r.cost_usd).toFixed(4)}` : '—',
                  key: i,
                }))}
              />
            </div>
          )}
          {preview.suggestedMappings.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Suggested mappings</h3>
              <DataTable
                columns={[
                  { key: 'source', label: 'Source field' },
                  { key: 'target', label: 'Target field' },
                  { key: 'confidence', label: 'Confidence' },
                ]}
                rows={preview.suggestedMappings.map((m) => ({
                  source: m.source,
                  target: m.target,
                  confidence: `${Math.round(m.confidence * 100)}%`,
                }))}
              />
            </div>
          )}
          {preview.errors.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-neg">Validation errors</h3>
              <ul className="text-sm text-neg">
                {preview.errors.map((e, i) => (
                  <li key={i}>
                    {e.recordRef}:{' '}
                    {typeof e.message === 'string' ? e.message : formatApiError({ message: e.message }, 'Unknown error')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

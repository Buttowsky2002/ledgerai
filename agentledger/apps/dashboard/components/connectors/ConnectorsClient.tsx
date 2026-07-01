'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { GitHubCopilotConnectForm } from '../copilot/GitHubCopilotConnectForm';
import { syncCopilotConnection, fetchCopilotConnections } from '../../lib/api/github-copilot';
import type { CopilotConnectionStatus } from '../../types/github-copilot';
import { Card, DataTable, PageHeader } from '../ui';
import {
  MAX_SYNC_DAYS,
  previewDateRange,
  rangeSpanDays,
  syncBatchCount,
  syncDateChunks,
} from '../../lib/sync-date-chunks';

type Connector = {
  connectorId: string;
  displayName: string;
  provider: string;
  category: string;
  status: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastErrorMessageSafe?: string | null;
  syncStatus?: {
    lastSyncAt: string | null;
    lastSyncStatus: string;
    recordsImported: number;
    usersDetected: number;
    unmappedRecords: number;
    spendSyncedUsd: number;
    errorMessage?: string | null;
  };
  capabilities?: {
    supportsUserLevelCost: boolean;
  };
  attributionWarning?: string;
};

type Preset = {
  definitionId?: string;
  name: string;
  provider: string;
  category: string;
  builtIn?: boolean;
  definitionJson?: {
    baseUrl?: string;
    authType?: string;
    category?: string;
    endpoints?: { path?: string; method?: string }[];
  };
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

const COPILOT_PRESET = 'github-copilot-business';
const LOCKED_PRESETS = new Set(['anthropic-usage', 'openai-usage', 'cursor-usage', COPILOT_PRESET]);

function isCopilotConnector(c: Connector): boolean {
  return c.provider === 'github_copilot_business' || c.category === 'license_usage_roi';
}

const PRESET_DEFAULTS: Record<
  string,
  { baseUrl: string; authType: string; endpointPath: string; category: string }
> = {
  'anthropic-usage': {
    baseUrl: 'https://api.anthropic.com',
    authType: 'api_key_header',
    endpointPath: '/v1/organizations/cost_report',
    category: 'provider_spend',
  },
  'openai-usage': {
    baseUrl: 'https://api.openai.com',
    authType: 'bearer_token',
    endpointPath: '/v1/organization/costs',
    category: 'provider_spend',
  },
  'cursor-usage': {
    baseUrl: 'https://api.cursor.com',
    authType: 'basic_auth',
    endpointPath: '/teams/filtered-usage-events',
    category: 'coding_tool',
  },
  'github-copilot-business': {
    baseUrl: 'https://api.github.com',
    authType: 'bearer_token',
    endpointPath: '/orgs/{org}/copilot/billing',
    category: 'license_usage_roi',
  },
};

function presetFormFields(presetId: string, presets: Preset[]) {
  const preset = presets.find((p) => (p.definitionId ?? p.name) === presetId);
  const def = preset?.definitionJson;
  if (def) {
    return {
      presetId,
      category: def.category ?? preset?.category ?? 'provider_spend',
      baseUrl: def.baseUrl ?? 'https://api.example.com',
      authType: def.authType ?? 'api_key_header',
      endpointPath: def.endpoints?.[0]?.path ?? '/v1/spend',
    };
  }
  const fallback = PRESET_DEFAULTS[presetId];
  return fallback ? { presetId, ...fallback } : { presetId };
}

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
  from.setUTCDate(from.getUTCDate() - 89);
  return { from: isoDate(from), to: isoDate(to) };
}

function ProgressBar({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-edge">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
}

export function ConnectorsClient() {
  const searchParams = useSearchParams();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [copilotConnections, setCopilotConnections] = useState<CopilotConnectionStatus[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testProgress, setTestProgress] = useState(0);
  const [syncProgress, setSyncProgress] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rangeFrom, setRangeFrom] = useState(() => defaultConnectorRange().from);
  const [rangeTo, setRangeTo] = useState(() => defaultConnectorRange().to);

  const [mappingForm, setMappingForm] = useState({
    mappingType: 'api_key',
    providerKey: '',
    targetUserId: '',
  });

  const [form, setForm] = useState({
    displayName: '',
    presetId: 'generic-rest-spend',
    category: 'provider_spend',
    baseUrl: 'https://api.example.com',
    authType: 'bearer_token',
    authSecret: '',
    endpointPath: '/v1/spend',
  });

  const [syncingCopilot, setSyncingCopilot] = useState<string | null>(null);

  const copilotByConnectorId = useMemo(() => {
    const map = new Map<string, CopilotConnectionStatus>();
    for (const c of copilotConnections) {
      map.set(c.connectorId, c);
    }
    return map;
  }, [copilotConnections]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [connRes, presetRes, copilotRes] = await Promise.all([
        fetch('/api/connectors'),
        fetch('/api/connector-definitions'),
        fetchCopilotConnections(),
      ]);
      if (connRes.ok) {
        const data: unknown = await connRes.json();
        setConnectors(Array.isArray(data) ? data : []);
      } else {
        setConnectors([]);
        setError('Could not load connectors — check that the API is running and you are signed in.');
      }
      if (presetRes.ok) {
        const data: unknown = await presetRes.json();
        setPresets(Array.isArray(data) ? data : []);
      }
      setCopilotConnections(copilotRes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (searchParams.get('preset') === COPILOT_PRESET) {
      setFormOpen(true);
      setForm((f) => ({ ...f, ...presetFormFields(COPILOT_PRESET, presets) }));
    }
  }, [searchParams, presets]);

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
    if (form.presetId === COPILOT_PRESET) {
      setError('Use Test token and Connect Copilot below for GitHub Copilot Business.');
      return;
    }
    setError(null);
    const locked = LOCKED_PRESETS.has(form.presetId);
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: form.displayName,
        presetId: form.presetId,
        category: form.category,
        baseUrl: locked ? undefined : form.baseUrl,
        authSecret: form.authSecret || undefined,
        configJson: locked ? {} : { endpointPath: form.endpointPath, authType: form.authType },
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

  const addMapping = async (connectorId: string) => {
    if (!mappingForm.providerKey || !mappingForm.targetUserId) return;
    setError(null);
    const res = await fetch(`/api/connectors/${connectorId}/attribution-mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mappingForm),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setError(formatApiError(body, 'Failed to save mapping'));
      return;
    }
    setMappingForm({ mappingType: 'api_key', providerKey: '', targetUserId: '' });
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

  const syncRangeBody = (from: string, to: string) => ({ from, to });
  const syncBatches = syncBatchCount(rangeFrom, rangeTo);
  const rangeDays = rangeSpanDays(rangeFrom, rangeTo);

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
    setTesting(id);
    setTestProgress(8);
    const progressTimer = window.setInterval(() => {
      setTestProgress((p) => (p >= 92 ? p : p + 6));
    }, 350);
    try {
      const previewRange = previewDateRange(rangeFrom, rangeTo);
      const res = await fetch(`/api/connectors/${id}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syncRangeBody(previewRange.from, previewRange.to)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(formatApiError(body, 'Test failed'));
        return;
      }
      const data = (await res.json()) as PreviewResult;
      setPreview(data);
      setTestProgress(100);
      startApiCooldown();
      if (data.warning) {
        setError(data.warning);
      } else if (data.errors?.length) {
        setError(data.errors.map((e) => `${e.recordRef}: ${e.message}`).join('; '));
      }
    } finally {
      window.clearInterval(progressTimer);
      window.setTimeout(() => {
        setTesting(null);
        setTestProgress(0);
      }, 600);
    }
  };

  const syncConnector = async (id: string) => {
    if (cooldownSec > 0) {
      setError(`Wait ${cooldownSec}s after Test before syncing (Anthropic rate limits).`);
      return;
    }
    const chunks = syncDateChunks(rangeFrom, rangeTo);
    if (chunks.length === 0) {
      setError('Invalid date range — From must be on or before To.');
      return;
    }

    setSyncing(id);
    setSyncProgress(8);
    setError(null);

    const progressTimer = window.setInterval(() => {
      setSyncProgress((p) => (p >= 92 ? p : p + 2));
    }, 1500);

    try {
      const res = await fetch(`/api/connectors/${id}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syncRangeBody(rangeFrom, rangeTo)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(formatApiError(body, 'Sync failed'));
        return;
      }

      const body = (await res.json()) as {
        recordsImported?: number;
        recordsSeen?: number;
        netSpendImportedUsd?: number;
        usersDetected?: number;
        unmappedRecords?: number;
        emptyWarning?: string;
        duplicateWarning?: string;
        userAttributionWarning?: string;
        syncRangeApplied?: { from?: string; to?: string };
      };
      setSyncProgress(100);

      if (body.userAttributionWarning) {
        setError(body.userAttributionWarning);
      } else if (body.emptyWarning) {
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
    } finally {
      window.clearInterval(progressTimer);
      setSyncing(null);
      window.setTimeout(() => setSyncProgress(0), 600);
    }
  };

  const syncCopilot = async (connectionId: string) => {
    setSyncingCopilot(connectionId);
    setError(null);
    const result = await syncCopilotConnection(connectionId);
    setSyncingCopilot(null);
    if (!result?.ok) {
      setError(result?.errorMessage ?? 'Copilot sync failed. Check token scopes (403) or org Copilot access.');
      return;
    }
    setError(null);
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
            error.includes('no cost rows') || error.includes('imported 0 rows') || error.includes('no billable cost')
              ? 'border-warn/40 bg-warn/10 text-warn'
              : 'border-neg/40 bg-neg/10 text-neg'
          }`}
        >
          {error}
        </div>
      )}

      {formOpen && (
        <>
          <Card title="Add data source" subtitle="Choose a provider template">
            <label className="block max-w-md text-sm">
              <span className="text-muted">Preset template</span>
              <select
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2"
                value={form.presetId}
                onChange={(e) => {
                  const presetId = e.target.value;
                  setForm((f) => ({ ...f, ...presetFormFields(presetId, presets) }));
                  setError(null);
                }}
              >
                {presets.filter((p) => p.builtIn !== false).map((p) => (
                  <option key={p.definitionId ?? p.name} value={p.definitionId ?? p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </Card>

          {form.presetId === COPILOT_PRESET ? (
            <Card title="GitHub Copilot Business" subtitle="Seat, usage, member spend, and estimated ROI">
              <GitHubCopilotConnectForm
                onConnected={() => {
                  setFormOpen(false);
                  void load();
                }}
              />
            </Card>
          ) : (
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
            <div className="hidden md:block" aria-hidden />
            <div className="md:col-span-2">
              {form.presetId === 'anthropic-usage' && (
                <p className="mt-1 text-xs text-muted">
                  Paste your Claude Console <strong>Admin API key</strong> (sk-ant-admin…) from
                  console.anthropic.com → Settings → Admin keys. Sync pulls{' '}
                  <code className="text-xs">cost_report</code> +{' '}
                  <code className="text-xs">usage_report/messages</code> (grouped by workspace and
                  model). Keys are stored encrypted server-side only; optional headless fallback:{' '}
                  <code className="text-xs">ANTHROPIC_ADMIN_API_KEY</code> env on the API service.
                </p>
              )}
              {form.presetId === 'cursor-usage' && (
                <p className="mt-1 text-xs text-muted">
                  Paste your Cursor <strong>Team Admin API key</strong> (cursor.com → Team settings → Admin API).
                  Auth is HTTP Basic (<code className="text-xs">curl -u YOUR_KEY:</code>); base URL must stay{' '}
                  https://api.cursor.com.
                </p>
              )}
            </div>
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
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2 disabled:opacity-50"
                value={form.baseUrl}
                disabled={LOCKED_PRESETS.has(form.presetId)}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Endpoint path</span>
              <input
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2 disabled:opacity-50"
                value={form.endpointPath}
                disabled={LOCKED_PRESETS.has(form.presetId)}
                onChange={(e) => setForm({ ...form, endpointPath: e.target.value })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Auth type</span>
              <select
                className="mt-1 w-full rounded border border-edge bg-black/20 px-3 py-2 disabled:opacity-50"
                value={form.authType}
                disabled={LOCKED_PRESETS.has(form.presetId)}
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
                placeholder={
                  form.presetId === 'cursor-usage'
                    ? 'Cursor Team Admin API key'
                    : form.presetId === 'anthropic-usage'
                      ? 'Claude Console Admin API key (sk-ant-admin…)'
                      : 'API key or bearer token'
                }
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
        </>
      )}

      <Card
        title="Sync time frame"
        subtitle={
          syncBatches > 1
            ? `${rangeDays} days total — the API splits this into ${syncBatches}×${MAX_SYNC_DAYS}-day windows server-side. Large Cursor ranges can take several minutes; sync one connector at a time. Test previews the latest ${MAX_SYNC_DAYS} days only.`
            : `Enabled connectors auto-sync every hour (last 31 days). Test previews usage; Sync now imports spend for the selected range.`
        }
      >
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex gap-2">
            {[7, 30, 90].map((days) => (
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

      <Card title="Connected data sources">
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : connectors.length === 0 ? (
          <p className="text-sm text-muted">No API connectors yet. Add one above to sync usage data.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {connectors.map((c) => {
              const sync = c.syncStatus;
              const lastSync = sync?.lastSyncAt ?? c.lastSuccessAt;
              const copilotConn = isCopilotConnector(c) ? copilotByConnectorId.get(c.connectorId) : undefined;
              const copilotLastSync = copilotConn?.lastSuccessAt ?? lastSync;
              const copilotRecords = copilotConn?.recordsImported;
              const copilotError = copilotConn?.lastErrorMessage ?? sync?.errorMessage ?? c.lastErrorMessageSafe;
              return (
                <div
                  key={c.connectorId}
                  className="rounded-lg border border-edge bg-black/20 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-medium capitalize text-gray-100">
                        {c.displayName ?? c.provider}
                      </h3>
                      <p className="text-xs text-muted">{c.provider} · {c.category}</p>
                    </div>
                    <span className={`text-xs font-medium ${statusTone(c.status)}`}>
                      {c.status === 'healthy' || c.status === 'connected' ? 'Connected' : c.status}
                    </span>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted">Last sync</dt>
                    <dd>{copilotLastSync ? new Date(copilotLastSync).toLocaleString() : '—'}</dd>
                    <dt className="text-muted">Records imported</dt>
                    <dd className="num">
                      {copilotRecords != null
                        ? copilotRecords.toLocaleString()
                        : sync?.recordsImported?.toLocaleString() ?? '—'}
                    </dd>
                    {!isCopilotConnector(c) && (
                      <>
                        <dt className="text-muted">Users detected</dt>
                        <dd className="num">{sync?.usersDetected ?? '—'}</dd>
                        <dt className="text-muted">Unmapped records</dt>
                        <dd className={`num ${(sync?.unmappedRecords ?? 0) > 0 ? 'text-warn' : ''}`}>
                          {sync?.unmappedRecords ?? '—'}
                        </dd>
                        <dt className="text-muted">Spend synced</dt>
                        <dd className="num">
                          {sync?.spendSyncedUsd != null && Number.isFinite(Number(sync.spendSyncedUsd))
                            ? `$${Number(sync.spendSyncedUsd).toFixed(2)}`
                            : '—'}
                        </dd>
                      </>
                    )}
                    {isCopilotConnector(c) && copilotConn && (
                      <>
                        <dt className="text-muted">Organization</dt>
                        <dd>{copilotConn.orgSlug}</dd>
                      </>
                    )}
                  </dl>

                  {copilotError && (
                    <p className="mt-2 text-xs text-neg">{copilotError}</p>
                  )}

                  {!isCopilotConnector(c) && (sync?.errorMessage || c.lastErrorMessageSafe) && (
                    <p className="mt-2 text-xs text-neg">
                      {sync?.errorMessage ?? c.lastErrorMessageSafe}
                    </p>
                  )}

                  {c.attributionWarning && (
                    <p className="mt-2 rounded border border-warn/30 bg-warn/10 p-2 text-xs text-warn">
                      {c.attributionWarning}
                    </p>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {isCopilotConnector(c) && !copilotConn && (
                      <p className="mt-2 text-xs text-warn">
                        Copilot connection metadata loading — refresh or complete setup in Add connector.
                      </p>
                    )}

                    {isCopilotConnector(c) && copilotConn ? (
                      <>
                        <Link
                          href="/"
                          className="text-xs text-accent hover:underline"
                        >
                          View in Overview
                        </Link>
                        <button
                          type="button"
                          className="rounded bg-accent/20 px-3 py-1 text-xs text-white hover:bg-accent/30 disabled:opacity-50"
                          disabled={syncingCopilot === copilotConn.connectionId}
                          onClick={() => void syncCopilot(copilotConn.connectionId)}
                        >
                          {syncingCopilot === copilotConn.connectionId ? 'Syncing…' : 'Sync Copilot data'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-xs text-accent hover:underline disabled:opacity-50"
                          disabled={testing === c.connectorId}
                          onClick={() => void testConnector(c.connectorId)}
                        >
                          {testing === c.connectorId ? 'Testing…' : 'Test'}
                        </button>
                        <button
                          type="button"
                          className="rounded bg-accent/20 px-3 py-1 text-xs text-white hover:bg-accent/30 disabled:opacity-50"
                          disabled={syncing === c.connectorId || cooldownSec > 0}
                          onClick={() => void syncConnector(c.connectorId)}
                        >
                          {syncing === c.connectorId
                            ? 'Syncing…'
                            : cooldownSec > 0
                              ? `Wait ${cooldownSec}s`
                              : 'Sync usage data'}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="text-xs text-neg hover:underline disabled:opacity-50"
                      disabled={deleting === c.connectorId}
                      onClick={() => void deleteConnector(c.connectorId, c.displayName ?? c.connectorId)}
                    >
                      {deleting === c.connectorId ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>

                  {testing === c.connectorId && !isCopilotConnector(c) && (
                    <ProgressBar progress={testProgress} label="Testing connection and normalizing sample rows…" />
                  )}
                  {syncing === c.connectorId && !isCopilotConnector(c) && (
                    <ProgressBar
                      progress={syncProgress}
                      label={
                        syncBatches > 1
                          ? `Syncing usage data (${syncBatches} server-side windows — may take several minutes)…`
                          : 'Syncing usage data from provider…'
                      }
                    />
                  )}

                  {(sync?.unmappedRecords ?? 0) > 0 && (
                    <div className="mt-4 border-t border-edge pt-3">
                      <p className="mb-2 text-xs font-semibold uppercase text-muted">
                        Map unassigned spend
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <select
                          className="rounded border border-edge bg-black/20 px-2 py-1 text-xs"
                          value={mappingForm.mappingType}
                          onChange={(e) => setMappingForm({ ...mappingForm, mappingType: e.target.value })}
                        >
                          <option value="api_key">API key</option>
                          <option value="project">Project</option>
                          <option value="workspace">Workspace</option>
                          <option value="service_account">Service account</option>
                          <option value="provider_user">Provider user</option>
                        </select>
                        <input
                          className="rounded border border-edge bg-black/20 px-2 py-1 text-xs"
                          placeholder="Provider key / ID"
                          value={mappingForm.providerKey}
                          onChange={(e) => setMappingForm({ ...mappingForm, providerKey: e.target.value })}
                        />
                        <input
                          className="rounded border border-edge bg-black/20 px-2 py-1 text-xs"
                          placeholder="Target user ID"
                          value={mappingForm.targetUserId}
                          onChange={(e) => setMappingForm({ ...mappingForm, targetUserId: e.target.value })}
                        />
                        <button
                          type="button"
                          className="rounded border border-edge px-2 py-1 text-xs hover:bg-white/5"
                          onClick={() => void addMapping(c.connectorId)}
                        >
                          Save mapping
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
          {Array.isArray(preview.normalizedPreview) && preview.normalizedPreview.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">Preview summary</h3>
              <p className="text-sm text-muted">
                {preview.normalizedPreview.length} sample row(s) · total preview spend $
                {preview.normalizedPreview
                  .reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
                  .toFixed(4)}
              </p>
            </div>
          )}
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
          {Array.isArray(preview.suggestedMappings) && preview.suggestedMappings.length > 0 && (
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
          {Array.isArray(preview.errors) && preview.errors.length > 0 && (
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

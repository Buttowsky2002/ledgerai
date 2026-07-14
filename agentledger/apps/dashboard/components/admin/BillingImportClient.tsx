'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge, Card, DataTable, PageHeader, Stat, usd } from '../ui';

type Connector = {
  connectorId: string;
  displayName: string;
  provider: string;
  kind: string | null;
  config?: Record<string, unknown>;
};

type ColumnMapping = {
  date?: string;
  cost: string;
  costUnit?: 'usd' | 'cents';
  reportThroughDay?: string;
  model?: string;
  product?: string;
  user?: string;
  user_name?: string;
  user_id?: string;
  account_uuid?: string;
  input_tokens?: string;
  output_tokens?: string;
};

type FormatInfo = {
  format: string;
  label: string;
  billable: boolean;
  hint: string;
  reportTo: string | null;
};

type PortalPreview = {
  headers: string[];
  format?: FormatInfo;
  mapping: ColumnMapping | null;
  provider?: string | null;
  requiresProvider?: boolean;
  importable: boolean;
  parsed: number;
  skipped: number;
  skippedZeroCost: number;
  usersDetected: number;
  totalCostUsd: number;
  dateRange: { from: string | null; to: string | null };
  parseErrors: { line: number; message: string }[];
  preview: Record<string, unknown>[];
  suggestion?: { missingRequired?: string[]; inferredCostUnit?: 'usd' | 'cents' };
};

type StagedFile = {
  name: string;
  csv: string;
  preview: PortalPreview | null;
  mapping: ColumnMapping | null;
  headerRoles: Record<string, string>;
  costUnit: 'usd' | 'cents';
  /** User-selected billing provider when format is ambiguous. */
  provider: string;
};

type UploadResult = {
  dryRun: boolean;
  parsed: number;
  imported: number;
  duplicateSkipped: number;
  usersDetected: number;
  totalCostUsd: number;
  dateRange: { from: string | null; to: string | null };
  suggestedApiSyncBaseline: string | null;
  files: { fileName: string; ok: boolean; error?: string; parsed: number; imported: number }[];
};

type Reconciliation = {
  from: string;
  to: string;
  days: { day: string; portalCostUsd: number; apiCostUsd: number }[];
  summary: { portalTotalUsd: number; apiTotalUsd: number; overlapDays: number };
};

type ImportRun = {
  id: string;
  legacy: boolean;
  createdAt: string;
  actor: string;
  provider: string;
  providers: string[];
  fileNames: string[];
  dateRange: { from: string | null; to: string | null };
  rowsImported: number;
  rowsSkipped: number;
  totalCostUsd: number;
  deletable: boolean;
};

const BILLING_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'azure', label: 'Azure OpenAI' },
] as const;

const COLUMN_ROLES = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'date', label: 'Date' },
  { value: 'cost', label: 'Cost (required)' },
  { value: 'model', label: 'Model' },
  { value: 'product', label: 'Product / project' },
  { value: 'user', label: 'User email' },
  { value: 'user_name', label: 'User display name' },
  { value: 'user_id', label: 'Provider user id' },
  { value: 'account_uuid', label: 'Account UUID' },
  { value: 'input_tokens', label: 'Input tokens' },
  { value: 'output_tokens', label: 'Output tokens' },
] as const;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 89);
  return { from: isoDate(from), to: isoDate(to) };
}

function formatApiError(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.detail === 'string') return body.detail;
  const msg = body.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
    const nested = msg as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof nested.message === 'string') parts.push(nested.message);
    if (Array.isArray(nested.errors)) {
      parts.push(...nested.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))));
    }
    if (Array.isArray(nested.files)) {
      for (const f of nested.files as Record<string, unknown>[]) {
        if (typeof f.fileName === 'string' && typeof f.error === 'string') {
          parts.push(`${f.fileName}: ${f.error}`);
        }
      }
    }
    if (parts.length) return parts.join(' · ');
  }
  return fallback;
}

function readHandoff(config?: Record<string, unknown>) {
  const cfg = config ?? {};
  return {
    portalImportThrough:
      typeof cfg.portalImportThrough === 'string' ? cfg.portalImportThrough.slice(0, 10) : null,
    apiSyncBaselineFrom:
      typeof cfg.apiSyncBaselineFrom === 'string' ? cfg.apiSyncBaselineFrom.slice(0, 10) : null,
  };
}

function rolesToMapping(roles: Record<string, string>, costUnit: 'usd' | 'cents', reportThroughDay?: string | null): ColumnMapping | null {
  const byRole: Record<string, string> = {};
  for (const [header, role] of Object.entries(roles)) {
    if (role && role !== 'ignore') byRole[role] = header;
  }
  if (!byRole.cost) return null;
  if (!byRole.date && !reportThroughDay) return null;
  return {
    ...(byRole.date ? { date: byRole.date } : {}),
    cost: byRole.cost,
    costUnit,
    ...(reportThroughDay ? { reportThroughDay } : {}),
    model: byRole.model,
    product: byRole.product,
    user: byRole.user,
    user_name: byRole.user_name,
    user_id: byRole.user_id,
    account_uuid: byRole.account_uuid,
    input_tokens: byRole.input_tokens,
    output_tokens: byRole.output_tokens,
  };
}

function mappingToRoles(mapping: ColumnMapping | null, headers: string[]): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const h of headers) roles[h] = 'ignore';
  if (!mapping) return roles;
  const set = (role: string, header?: string) => {
    if (header && headers.includes(header)) roles[header] = role;
  };
  set('date', mapping.date);
  set('cost', mapping.cost);
  set('model', mapping.model);
  set('product', mapping.product);
  set('user', mapping.user);
  set('user_name', mapping.user_name);
  set('user_id', mapping.user_id);
  set('account_uuid', mapping.account_uuid);
  set('input_tokens', mapping.input_tokens);
  set('output_tokens', mapping.output_tokens);
  return roles;
}

function dayStatus(portal: number, api: number): { label: string; tone: 'pos' | 'warn' | 'info' | 'neutral' } {
  if (portal > 0 && api > 0) return { label: 'Overlap risk', tone: 'warn' };
  if (portal > 0) return { label: 'Portal only', tone: 'info' };
  if (api > 0) return { label: 'API only', tone: 'pos' };
  return { label: '—', tone: 'neutral' };
}

export function BillingImportClient() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connectorId, setConnectorId] = useState('');
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [activeFileIdx, setActiveFileIdx] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [rangeFrom, setRangeFrom] = useState(() => defaultRange().from);
  const [rangeTo, setRangeTo] = useState(() => defaultRange().to);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [loadingRecon, setLoadingRecon] = useState(false);
  const [importRuns, setImportRuns] = useState<ImportRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  const anthropicConnectors = useMemo(
    () => connectors.filter((c) => c.provider === 'anthropic' || c.kind === 'anthropic-usage'),
    [connectors],
  );
  const hasAnthropicImport = stagedFiles.some(
    (f) => (f.provider || f.preview?.provider) === 'anthropic',
  );
  const selectedConnector = connectors.find((c) => c.connectorId === connectorId);
  const handoff = readHandoff(selectedConnector?.config);
  const activeFile = stagedFiles[activeFileIdx] ?? null;

  const loadConnectors = useCallback(async () => {
    const res = await fetch('/api/connectors');
    const body = (await res.json()) as Connector[] | { error?: string };
    if (!res.ok) return;
    const list = Array.isArray(body) ? body : [];
    setConnectors(list);
  }, []);

  const loadReconciliation = useCallback(async () => {
    setLoadingRecon(true);
    try {
      const qs = new URLSearchParams({ from: rangeFrom, to: rangeTo });
      const res = await fetch(`/api/analytics/source-reconciliation?${qs}`);
      const body = (await res.json()) as Reconciliation | Record<string, unknown>;
      if (res.ok) setReconciliation(body as Reconciliation);
    } finally {
      setLoadingRecon(false);
    }
  }, [rangeFrom, rangeTo]);

  const loadImportRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await fetch('/api/portal-import/runs?limit=40');
      const body = (await res.json()) as { runs?: ImportRun[] };
      if (res.ok) setImportRuns(body.runs ?? []);
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  useEffect(() => {
    void loadReconciliation();
  }, [loadReconciliation]);

  useEffect(() => {
    void loadImportRuns();
  }, [loadImportRuns]);

  const runPreview = useCallback(async (file: StagedFile, mapping?: ColumnMapping | null) => {
    const res = await fetch('/api/portal-import/anthropic/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csv: file.csv,
        fileName: file.name,
        mapping: mapping ?? undefined,
        provider: file.provider || undefined,
      }),
    });
    const body = (await res.json()) as PortalPreview & Record<string, unknown>;
    if (!res.ok) throw new Error(formatApiError(body, 'Preview failed'));
    return body as PortalPreview;
  }, []);

  async function onFilesSelected(fileList: FileList | null) {
    if (!fileList?.length) return;
    setError(null);
    setUploadResult(null);
    setPreviewing(true);
    try {
      const next: StagedFile[] = [];
      for (const file of Array.from(fileList)) {
        const csv = await file.text();
        const stub: StagedFile = {
          name: file.name,
          csv,
          preview: null,
          mapping: null,
          headerRoles: {},
          costUnit: 'usd',
          provider: '',
        };
        const preview = await runPreview(stub);
        const mapping = preview.mapping;
        const costUnit = mapping?.costUnit ?? preview.suggestion?.inferredCostUnit ?? 'usd';
        const provider = preview.provider ?? '';
        next.push({
          ...stub,
          preview,
          mapping,
          costUnit,
          provider,
          headerRoles: mappingToRoles(mapping, preview.headers),
        });
      }
      setStagedFiles(next);
      setActiveFileIdx(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  async function refreshActivePreview(
    roles: Record<string, string>,
    costUnit: 'usd' | 'cents',
  ) {
    if (!activeFile) return;
    const reportThroughDay =
      activeFile.mapping?.reportThroughDay ?? activeFile.preview?.format?.reportTo ?? null;
    const mapping = rolesToMapping(roles, costUnit, reportThroughDay);
    setPreviewing(true);
    setError(null);
    try {
      const preview = await runPreview(activeFile, mapping);
      setStagedFiles((prev) =>
        prev.map((f, i) =>
          i === activeFileIdx
            ? { ...f, preview, mapping, headerRoles: roles, costUnit }
            : f,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  function updateHeaderRole(header: string, role: string) {
    if (!activeFile) return;
    const roles = { ...activeFile.headerRoles, [header]: role };
    void refreshActivePreview(roles, activeFile.costUnit);
  }

  function applyMappingToAllFiles() {
    if (!activeFile?.mapping) return;
    setStagedFiles((prev) =>
      prev.map((f, i) =>
        i === activeFileIdx
          ? f
          : {
              ...f,
              mapping: activeFile.mapping,
              headerRoles: mappingToRoles(activeFile.mapping, f.preview?.headers ?? []),
              costUnit: activeFile.costUnit,
            },
      ),
    );
  }

  async function onProviderChange(provider: string) {
    if (!activeFile) return;
    const updated = { ...activeFile, provider };
    setStagedFiles((prev) => prev.map((f, i) => (i === activeFileIdx ? updated : f)));
    setPreviewing(true);
    setError(null);
    try {
      const preview = await runPreview(updated, updated.mapping);
      setStagedFiles((prev) =>
        prev.map((f, i) => (i === activeFileIdx ? { ...f, preview, provider } : f)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  async function onImport(dryRun: boolean) {
    if (!stagedFiles.length) {
      setError('Choose one or more CSV files first');
      return;
    }
    setUploading(true);
    setError(null);
    setUploadResult(null);
    try {
      const res = await fetch('/api/portal-import/anthropic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: stagedFiles.map((f) => {
            const reportThroughDay =
              f.mapping?.reportThroughDay ?? f.preview?.format?.reportTo ?? null;
            return {
              name: f.name,
              csv: f.csv,
              mapping: f.mapping ?? rolesToMapping(f.headerRoles, f.costUnit, reportThroughDay) ?? undefined,
              provider: f.provider || f.preview?.provider || undefined,
            };
          }),
          connectorId: hasAnthropicImport ? connectorId || undefined : undefined,
          dryRun,
        }),
      });
      const body = (await res.json()) as UploadResult & Record<string, unknown>;
      if (!res.ok) {
        setError(formatApiError(body, 'Import failed'));
        return;
      }
      setUploadResult(body as UploadResult);
      if (!dryRun) {
        await loadConnectors();
        await loadReconciliation();
        await loadImportRuns();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteRun(run: ImportRun) {
    const label = run.legacy
      ? `legacy import (${run.dateRange.from ?? '?'} → ${run.dateRange.to ?? '?'})`
      : run.fileNames[0] ?? run.provider;
    const msg = run.legacy
      ? `Delete all portal import spend for ${label}? This removes every import row in that date window for the listed provider(s) — not just one file.`
      : `Delete imported spend for "${label}"? This removes ${run.rowsImported} rows (${usd(run.totalCostUsd)}) from platform totals.`;
    if (!window.confirm(msg)) return;

    setDeletingRunId(run.id);
    setError(null);
    try {
      const res = await fetch(`/api/portal-import/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError(formatApiError(body, 'Delete failed'));
        return;
      }
      await loadImportRuns();
      await loadReconciliation();
    } finally {
      setDeletingRunId(null);
    }
  }

  const canImport = stagedFiles.some(
    (f) =>
      f.preview?.importable &&
      f.preview?.format?.billable !== false &&
      !f.preview?.requiresProvider,
  );
  const previewRows = (activeFile?.preview?.preview ?? []).map((r) => ({
    day: String(r.timestamp ?? '').slice(0, 10),
    user: String(r.user_id ?? '—'),
    provider: String(r.provider ?? '—'),
    model: String(r.model ?? '—'),
    cost: usd(Number(r.cost_usd ?? 0)),
  }));

  const historyRows = importRuns.map((run) => {
    const providerLabel =
      BILLING_PROVIDERS.find((p) => p.value === run.provider)?.label ?? run.provider;
    const files =
      run.fileNames.length > 0
        ? run.fileNames.join(', ')
        : run.legacy
          ? 'Legacy import (audit log)'
          : '—';
    const range =
      run.dateRange.from && run.dateRange.to
        ? `${run.dateRange.from} → ${run.dateRange.to}`
        : '—';
    return {
      when: new Date(run.createdAt).toLocaleString(),
      provider: (
        <span className="inline-flex items-center gap-2">
          {providerLabel}
          {run.legacy ? <Badge tone="warn">Legacy</Badge> : null}
        </span>
      ),
      files,
      range,
      imported: `${run.rowsImported}${run.rowsSkipped > 0 ? ` (+${run.rowsSkipped} dup)` : ''}`,
      total: usd(run.totalCostUsd),
      actions: run.deletable ? (
        <button
          type="button"
          disabled={deletingRunId === run.id}
          onClick={() => void onDeleteRun(run)}
          className="rounded-md border border-neg/40 px-2 py-1 text-xs text-neg hover:bg-neg/10 disabled:opacity-50"
        >
          {deletingRunId === run.id ? 'Deleting…' : 'Delete'}
        </button>
      ) : (
        <span className="text-xs text-muted">—</span>
      ),
    };
  });

  const reconRows = (reconciliation?.days ?? []).map((d) => {
    const status = dayStatus(d.portalCostUsd, d.apiCostUsd);
    return {
      day: d.day,
      portal: usd(d.portalCostUsd),
      api: usd(d.apiCostUsd),
      status: <Badge tone={status.tone}>{status.label}</Badge>,
    };
  });

  return (
    <div>
      <PageHeader
        eyebrow="Admin"
        title="Billing import"
        subtitle="Upload provider billing CSVs. Format is auto-detected; ambiguous files require you to pick the billing provider. Cursor analytics and Claude Code line reports are detected but cannot be imported as billing data."
      />

      {error && (
        <div className="mb-6 rounded-lg border border-neg/30 bg-neg/10 px-4 py-3 text-sm text-neg">{error}</div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Portal total" value={usd(reconciliation?.summary.portalTotalUsd)} sub="CSV imports" />
        <Stat label="API total" value={usd(reconciliation?.summary.apiTotalUsd)} sub="Connector sync" />
        <Stat
          label="Overlap days"
          value={String(reconciliation?.summary.overlapDays ?? 0)}
          sub="Both sources — review for double-counting"
          tone={(reconciliation?.summary.overlapDays ?? 0) > 0 ? 'warn' : 'default'}
        />
      </div>

      <Card title="Upload CSVs" subtitle="Select one or more files. Each file is analyzed before import.">
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {hasAnthropicImport && (
              <label className="block text-sm">
                <span className="mb-1 block text-muted">
                  Anthropic API sync handoff (optional)
                </span>
                <span className="mb-2 block text-xs text-muted">
                  Only updates connector sync dates after Anthropic imports — does not set the billing provider.
                </span>
                <select
                  className="w-full rounded-lg border border-edge bg-black/20 px-3 py-2 text-sm"
                  value={connectorId}
                  onChange={(e) => setConnectorId(e.target.value)}
                >
                  <option value="">— None —</option>
                  {anthropicConnectors.map((c) => (
                    <option key={c.connectorId} value={c.connectorId}>
                      {c.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={`block text-sm ${hasAnthropicImport ? '' : 'md:col-span-2'}`}>
              <span className="mb-1 block text-muted">Billing CSV(s)</span>
              <input
                type="file"
                accept=".csv,text/csv"
                multiple
                className="w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-accent/20 file:px-3 file:py-2 file:text-sm file:text-white"
                onChange={(e) => void onFilesSelected(e.target.files)}
              />
            </label>
          </div>

          {stagedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {stagedFiles.map((f, i) => (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => setActiveFileIdx(i)}
                  className={`rounded-md px-3 py-1.5 text-xs ${
                    i === activeFileIdx ? 'bg-accent/30 text-white' : 'bg-white/5 text-muted hover:bg-white/10'
                  }`}
                >
                  {f.name}
                  {f.preview?.importable ? (
                    <span className="ml-1 text-pos">✓</span>
                  ) : (
                    <span className="ml-1 text-warn">!</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>

      {activeFile && (
        <Card
          title="Column mapping"
          subtitle="Map CSV columns to billing fields. Cost is required; date or report end date (from filename) stamps each row."
          actions={
            stagedFiles.length > 1 ? (
              <button
                type="button"
                onClick={applyMappingToAllFiles}
                className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:bg-white/5"
              >
                Apply mapping to all files
              </button>
            ) : undefined
          }
        >
          {previewing && <p className="mb-3 text-sm text-muted">Analyzing…</p>}
          {activeFile.preview?.format && (
            <div
              className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
                activeFile.preview.format.billable
                  ? 'border-accent/30 bg-accent/10 text-white'
                  : 'border-warn/30 bg-warn/10 text-warn'
              }`}
            >
              <div className="font-medium">{activeFile.preview.format.label}</div>
              <div className="mt-1 text-xs opacity-90">{activeFile.preview.format.hint}</div>
              {activeFile.preview.format.reportTo && activeFile.preview.format.billable && (
                <div className="mt-1 text-xs opacity-90">
                  Rows without a date column will be stamped with report end date{' '}
                  <span className="font-mono">{activeFile.preview.format.reportTo}</span>.
                </div>
              )}
            </div>
          )}
          {!activeFile.preview?.importable && activeFile.preview && (
            <div className="mb-4 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
              {activeFile.preview.format?.billable === false
                ? 'This file is not billable — use a provider spend/billing export CSV instead.'
                : activeFile.preview.requiresProvider
                  ? 'Select a billing provider below — imports are stamped with the provider you choose, not the Anthropic connector.'
                  : activeFile.preview.skippedZeroCost > 0
                  ? `${activeFile.preview.skippedZeroCost} rows have zero/missing cost — verify the cost column or switch cost unit to cents.`
                  : 'Could not parse importable rows — adjust column mapping below.'}
              {activeFile.preview.parseErrors[0] && (
                <div className="mt-1 text-xs opacity-90">{activeFile.preview.parseErrors[0].message}</div>
              )}
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-muted">
              Billing provider:
              <select
                value={activeFile.provider}
                onChange={(e) => void onProviderChange(e.target.value)}
                className="rounded border border-edge bg-black/20 px-2 py-1 text-sm text-gray-200"
              >
                <option value="">
                  {activeFile.preview?.provider
                    ? `Auto: ${BILLING_PROVIDERS.find((p) => p.value === activeFile.preview?.provider)?.label ?? activeFile.preview.provider}`
                    : '— Select provider —'}
                </option>
                {BILLING_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              Cost unit:
              <select
                value={activeFile.costUnit}
                onChange={(e) =>
                  void refreshActivePreview(activeFile.headerRoles, e.target.value as 'usd' | 'cents')
                }
                className="rounded border border-edge bg-black/20 px-2 py-1 text-sm text-gray-200"
              >
                <option value="usd">USD (e.g. 12.50)</option>
                <option value="cents">Cents (e.g. 1250 = $12.50)</option>
              </select>
            </label>
            {activeFile.preview?.importable && (
              <span className="text-sm text-muted">
                {activeFile.preview.parsed} rows · {activeFile.preview.usersDetected} users ·{' '}
                {usd(activeFile.preview.totalCostUsd)}
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="table mb-4">
              <thead>
                <tr>
                  <th>CSV column</th>
                  <th>Maps to</th>
                  <th>Sample value</th>
                </tr>
              </thead>
              <tbody>
                {activeFile.preview?.headers.map((header, idx) => (
                  <tr key={header}>
                    <td className="font-mono text-xs">{header}</td>
                    <td>
                      <select
                        value={activeFile.headerRoles[header] ?? 'ignore'}
                        onChange={(e) => updateHeaderRole(header, e.target.value)}
                        className="w-full max-w-xs rounded border border-edge bg-black/20 px-2 py-1 text-sm"
                      >
                        {COLUMN_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="text-xs text-muted">
                      {activeFile.preview?.preview[0]
                        ? String(
                            (activeFile.preview.preview[0] as Record<string, unknown>)[
                              header.toLowerCase().replace(/\s+/g, '_')
                            ] ?? '—',
                          )
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {previewRows.length > 0 && (
            <>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Parsed preview</h3>
              <DataTable
                columns={[
                  { key: 'day', label: 'Day' },
                  { key: 'user', label: 'User' },
                  { key: 'provider', label: 'Provider' },
                  { key: 'model', label: 'Model' },
                  { key: 'cost', label: 'Cost', align: 'right' },
                ]}
                rows={previewRows}
              />
            </>
          )}
        </Card>
      )}

      <Card title="Import">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={uploading || previewing || !canImport}
            onClick={() => void onImport(false)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {uploading ? 'Importing…' : `Import ${stagedFiles.length || ''} file(s)`}
          </button>
          <button
            type="button"
            disabled={uploading || previewing || !canImport}
            onClick={() => void onImport(true)}
            className="rounded-lg border border-edge px-4 py-2 text-sm text-muted hover:bg-white/5 disabled:opacity-50"
          >
            Dry run
          </button>
        </div>

        {uploadResult && (
          <div className="mt-4 rounded-lg border border-pos/20 bg-pos/5 px-4 py-3 text-sm">
            <div className="font-medium text-gray-100">
              {uploadResult.dryRun ? 'Dry run complete' : 'Import complete'}
            </div>
            <ul className="mt-2 space-y-1 text-muted">
              <li>
                {uploadResult.parsed} rows parsed
                {!uploadResult.dryRun &&
                  ` · ${uploadResult.imported} imported · ${uploadResult.duplicateSkipped} duplicates skipped`}
              </li>
              <li>
                {uploadResult.usersDetected} users · {usd(uploadResult.totalCostUsd)} total
              </li>
              {uploadResult.dateRange.from && (
                <li>
                  Date range: {uploadResult.dateRange.from} → {uploadResult.dateRange.to}
                </li>
              )}
              {uploadResult.suggestedApiSyncBaseline && (
                <li>Suggested API sync start: {uploadResult.suggestedApiSyncBaseline}</li>
              )}
            </ul>
            {uploadResult.files?.length > 1 && (
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {uploadResult.files.map((f) => (
                  <li key={f.fileName}>
                    {f.fileName}: {f.ok ? `${f.parsed} rows` : f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Import history"
        subtitle="Past billing CSV imports. Deleting a run removes its spend from overview, users, and reconciliation."
        actions={
          <button
            type="button"
            disabled={loadingRuns}
            onClick={() => void loadImportRuns()}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:bg-white/5"
          >
            {loadingRuns ? 'Loading…' : 'Refresh'}
          </button>
        }
      >
        {importRuns.length === 0 && !loadingRuns ? (
          <p className="text-sm text-muted">No import runs yet. Imports after this deploy are tracked individually.</p>
        ) : (
          <DataTable
            columns={[
              { key: 'when', label: 'When' },
              { key: 'provider', label: 'Provider' },
              { key: 'files', label: 'Files' },
              { key: 'range', label: 'Date range' },
              { key: 'imported', label: 'Rows', align: 'right' },
              { key: 'total', label: 'Total', align: 'right' },
              { key: 'actions', label: '' },
            ]}
            rows={historyRows}
          />
        )}
      </Card>

      <Card
        title="Source reconciliation"
        subtitle="Daily spend by ingestion source."
        actions={
          <button
            type="button"
            disabled={loadingRecon}
            onClick={() => void loadReconciliation()}
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:bg-white/5"
          >
            {loadingRecon ? 'Loading…' : 'Refresh'}
          </button>
        }
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted">From</span>
            <input type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className="rounded-lg border border-edge bg-black/20 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted">To</span>
            <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className="rounded-lg border border-edge bg-black/20 px-3 py-2 text-sm" />
          </label>
        </div>
        <DataTable
          columns={[
            { key: 'day', label: 'Day' },
            { key: 'portal', label: 'Portal CSV', align: 'right' },
            { key: 'api', label: 'API sync', align: 'right' },
            { key: 'status', label: 'Status' },
          ]}
          rows={reconRows}
        />
      </Card>
    </div>
  );
}

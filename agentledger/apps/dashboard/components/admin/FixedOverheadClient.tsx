'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, DataTable, PageHeader, Stat, usd } from '@/components/ui';
import { combinedAiCost } from '@/lib/combined-ai-cost';
import {
  createFixedCost,
  deleteFixedCost,
  fetchFixedCostRows,
  fetchMeteredSpend,
  fetchTotalCostOfAi,
  updateFixedCost,
} from '@/lib/api/fixed-costs';
import type { FixedCostRow, FixedCostType, FixedCostVendor, PlanPreset } from '@/types/fixed-costs';

const PLAN_PRESETS: PlanPreset[] = [
  {
    id: 'chatgpt-team',
    label: 'ChatGPT Team',
    vendor: 'openai',
    costType: 'seat_license',
    lineItem: 'ChatGPT Team',
    defaultUnitUsd: 30,
  },
  {
    id: 'chatgpt-enterprise',
    label: 'ChatGPT Enterprise',
    vendor: 'openai',
    costType: 'subscription',
    lineItem: 'ChatGPT Enterprise',
    defaultUnitUsd: null,
  },
  {
    id: 'claude-team',
    label: 'Claude Team',
    vendor: 'anthropic',
    costType: 'seat_license',
    lineItem: 'Claude Team',
    defaultUnitUsd: 30,
  },
  {
    id: 'claude-enterprise',
    label: 'Claude Enterprise',
    vendor: 'anthropic',
    costType: 'subscription',
    lineItem: 'Claude Enterprise',
    defaultUnitUsd: null,
  },
  {
    id: 'custom',
    label: 'Custom',
    vendor: 'other',
    costType: 'seat_license',
    lineItem: '',
    defaultUnitUsd: null,
  },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  return { from: isoDate(from), to: isoDate(to) };
}

function monthInputValue(periodMonth: string): string {
  return String(periodMonth).slice(0, 7);
}

function periodMonthFromInput(monthValue: string): string {
  if (!monthValue) return '';
  return `${monthValue}-01`;
}

function vendorLabel(v: string): string {
  if (v === 'openai') return 'OpenAI';
  if (v === 'anthropic') return 'Anthropic';
  return v;
}

function costTypeLabel(t: string): string {
  return t.replace(/_/g, ' ');
}

type EditKey = {
  periodMonth: string;
  vendor: FixedCostVendor;
  costType: FixedCostType;
  lineItem?: string;
};

export function FixedOverheadClient() {
  const [rangeFrom, setRangeFrom] = useState(() => defaultRange().from);
  const [rangeTo, setRangeTo] = useState(() => defaultRange().to);
  const [rows, setRows] = useState<FixedCostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [impact, setImpact] = useState({ attributable: 0, fixed: 0, total: 0 });

  const [editKey, setEditKey] = useState<EditKey | null>(null);
  const [presetId, setPresetId] = useState('chatgpt-team');
  const [billingMonth, setBillingMonth] = useState(() => monthInputValue(isoDate(new Date())));
  const [seats, setSeats] = useState('');
  const [unitCostUsd, setUnitCostUsd] = useState('');
  const [costUsd, setCostUsd] = useState('');
  const [costManual, setCostManual] = useState(false);
  const [lineItem, setLineItem] = useState('');
  const [note, setNote] = useState('');

  const preset = useMemo(
    () => PLAN_PRESETS.find((p) => p.id === presetId) ?? PLAN_PRESETS[0],
    [presetId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, totals, metered] = await Promise.all([
        fetchFixedCostRows({ from: rangeFrom, to: rangeTo }),
        fetchTotalCostOfAi({ from: rangeFrom, to: rangeTo }),
        fetchMeteredSpend({ from: rangeFrom, to: rangeTo }),
      ]);
      setRows(list.rows);
      setImpact(combinedAiCost(metered, totals.rows));
      const loadErr = list.error ?? totals.error;
      if (loadErr) setError(loadErr);
    } finally {
      setLoading(false);
    }
  }, [rangeFrom, rangeTo]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (costManual) return;
    const s = Number(seats);
    const u = Number(unitCostUsd);
    if (seats !== '' && unitCostUsd !== '' && Number.isFinite(s) && Number.isFinite(u) && s >= 0 && u >= 0) {
      setCostUsd(String(s * u));
    }
  }, [seats, unitCostUsd, costManual]);

  useEffect(() => {
    if (editKey) return;
    if (preset.defaultUnitUsd != null) {
      setUnitCostUsd(String(preset.defaultUnitUsd));
    } else {
      setUnitCostUsd('');
    }
    if (preset.id !== 'custom') {
      setLineItem(preset.lineItem);
    }
  }, [preset, editKey]);

  function resetForm() {
    setEditKey(null);
    setPresetId('chatgpt-team');
    setBillingMonth(monthInputValue(isoDate(new Date())));
    setSeats('');
    setUnitCostUsd('30');
    setCostUsd('');
    setCostManual(false);
    setLineItem('ChatGPT Team');
    setNote('');
    setError(null);
  }

  function startEdit(row: FixedCostRow) {
    const match =
      PLAN_PRESETS.find(
        (p) =>
          p.vendor === row.vendor &&
          p.costType === row.cost_type &&
          (p.lineItem === row.line_item || (p.id === 'custom' && row.vendor === 'other')),
      ) ??
      PLAN_PRESETS.find((p) => p.id === 'custom');

    setEditKey({
      periodMonth: String(row.period_month).slice(0, 10),
      vendor: row.vendor,
      costType: row.cost_type,
      lineItem: row.line_item || undefined,
    });
    setPresetId(match?.id ?? 'custom');
    setBillingMonth(monthInputValue(String(row.period_month)));
    setSeats(row.seats > 0 ? String(row.seats) : '');
    setUnitCostUsd(row.unit_cost_usd > 0 ? String(row.unit_cost_usd) : '');
    setCostUsd(String(row.cost_usd));
    setCostManual(true);
    setLineItem(row.line_item || '');
    setNote(row.note || '');
    setError(null);
    setSuccess(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const periodMonth = periodMonthFromInput(billingMonth);
    if (!/^\d{4}-\d{2}-01$/.test(periodMonth)) {
      setError('Select a billing month.');
      return;
    }

    const total = Number(costUsd);
    if (!Number.isFinite(total) || total < 0) {
      setError('Enter a valid total cost (USD).');
      return;
    }

    if (preset.id === 'custom' && !lineItem.trim()) {
      setError('Enter a line item name for custom plans.');
      return;
    }

    const seatsNum = seats === '' ? undefined : Number(seats);
    const unitNum = unitCostUsd === '' ? undefined : Number(unitCostUsd);
    if (seatsNum !== undefined && (!Number.isInteger(seatsNum) || seatsNum < 0)) {
      setError('Seats must be a non-negative whole number.');
      return;
    }
    if (unitNum !== undefined && (!Number.isFinite(unitNum) || unitNum < 0)) {
      setError('Price per seat must be non-negative.');
      return;
    }

    const payload = {
      periodMonth,
      vendor: preset.vendor,
      costType: preset.costType,
      costUsd: total,
      lineItem: lineItem.trim() || preset.lineItem || undefined,
      seats: seatsNum,
      unitCostUsd: unitNum,
      note: note.trim() || undefined,
    };

    setSaving(true);
    try {
      const result = editKey
        ? await updateFixedCost({
            ...payload,
            periodMonth: editKey.periodMonth,
            vendor: editKey.vendor,
            costType: editKey.costType,
            lineItem: editKey.lineItem ?? payload.lineItem,
          })
        : await createFixedCost(payload);

      if (!result.ok) {
        const hint =
          result.status === 400
            ? ' An entry may already exist for this month, vendor, and cost type — try editing it instead.'
            : '';
        setError(result.error + hint);
        return;
      }

      setSuccess(editKey ? 'Fixed overhead updated.' : 'Fixed overhead saved.');
      resetForm();
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(row: FixedCostRow) {
    const label = `${String(row.period_month).slice(0, 7)} · ${vendorLabel(row.vendor)} · ${row.line_item || row.cost_type}`;
    if (!window.confirm(`Delete fixed overhead entry?\n\n${label}`)) return;

    setError(null);
    setSuccess(null);
    const result = await deleteFixedCost({
      periodMonth: String(row.period_month).slice(0, 10),
      vendor: row.vendor,
      costType: row.cost_type,
      lineItem: row.line_item || undefined,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSuccess('Entry deleted.');
    if (
      editKey &&
      editKey.periodMonth === String(row.period_month).slice(0, 10) &&
      editKey.vendor === row.vendor &&
      editKey.costType === row.cost_type
    ) {
      resetForm();
    }
    await load();
  }

  const fixedPct = impact.total > 0 ? (impact.fixed / impact.total) * 100 : 0;

  const tableRows = rows.map((r) => ({
    month: String(r.period_month).slice(0, 7),
    plan: r.line_item || costTypeLabel(r.cost_type),
    vendor: vendorLabel(r.vendor),
    seats: r.seats > 0 ? String(r.seats) : '—',
    unit: r.unit_cost_usd > 0 ? usd(r.unit_cost_usd) : '—',
    total: usd(r.cost_usd),
    actions: (
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="text-xs text-accent hover:underline"
          onClick={() => startEdit(r)}
        >
          Edit
        </button>
        <button
          type="button"
          className="text-xs text-neg hover:underline"
          onClick={() => void onDelete(r)}
        >
          Delete
        </button>
      </div>
    ),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Fixed overhead"
        subtitle="Seat licenses and subscriptions (ChatGPT, Claude) — un-attributable AI spend"
        actions={
          <Link href="/" className="text-sm text-muted hover:text-gray-200">
            Back to overview
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Total cost of AI" value={usd(impact.total)} accent sub={`${rangeFrom} → ${rangeTo}`} />
        <Stat label="Attributable (metered)" value={usd(impact.attributable)} sub="Gateway & connector usage" />
        <Stat
          label="Fixed overhead"
          value={usd(impact.fixed)}
          tone="warn"
          sub={`${fixedPct.toFixed(1)}% of total in range`}
        />
      </div>

      <Card title={editKey ? 'Edit entry' : 'Add seats & plan'} subtitle="Costs roll into Total cost of AI on Overview">
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Billing month</span>
              <input
                type="month"
                className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                value={billingMonth}
                onChange={(e) => setBillingMonth(e.target.value)}
                disabled={!!editKey}
                required
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-muted">Plan</span>
              <select
                className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                disabled={!!editKey}
              >
                {PLAN_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            {preset.id === 'custom' && (
              <label className="block text-sm">
                <span className="mb-1 block text-muted">Line item</span>
                <input
                  type="text"
                  className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                  value={lineItem}
                  onChange={(e) => setLineItem(e.target.value)}
                  placeholder="e.g. Platform fee"
                  disabled={!!editKey}
                />
              </label>
            )}

            <label className="block text-sm">
              <span className="mb-1 block text-muted">Seats</span>
              <input
                type="number"
                min={0}
                step={1}
                className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                value={seats}
                onChange={(e) => {
                  setSeats(e.target.value);
                  setCostManual(false);
                }}
                placeholder={preset.costType === 'subscription' ? 'Optional' : 'e.g. 10'}
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-muted">Price per seat / month (USD)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                value={unitCostUsd}
                onChange={(e) => {
                  setUnitCostUsd(e.target.value);
                  setCostManual(false);
                }}
                placeholder={preset.defaultUnitUsd != null ? String(preset.defaultUnitUsd) : 'Manual total below'}
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-muted">Total cost (USD)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                value={costUsd}
                onChange={(e) => {
                  setCostUsd(e.target.value);
                  setCostManual(true);
                }}
                required
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-muted">Note (optional)</span>
            <input
              type="text"
              className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Annual contract, PO #1234"
            />
          </label>

          {error && (
            <div className="text-sm text-neg">
              <p>{error}</p>
              {!error.includes('Admin role') && (
                <p className="mt-1 text-xs text-muted">
                  On an upgraded local stack, run <code className="rounded bg-canvas px-1">make migrate</code> to
                  apply ClickHouse migration 012 (fixed_costs).
                </p>
              )}
            </div>
          )}
          {success && <p className="text-sm text-pos">{success}</p>}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : editKey ? 'Update entry' : 'Save entry'}
            </button>
            {editKey && (
              <button
                type="button"
                className="rounded border border-edge px-4 py-2 text-sm text-muted hover:bg-white/5"
                onClick={resetForm}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </Card>

      <Card
        title="Recorded overhead"
        subtitle="Entries in selected date range"
        actions={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="date"
              className="rounded border border-edge bg-canvas px-2 py-1"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
            />
            <span className="text-muted">→</span>
            <input
              type="date"
              className="rounded border border-edge bg-canvas px-2 py-1"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
            />
          </div>
        }
      >
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tableRows.length === 0 ? (
          <p className="text-sm text-muted">No fixed overhead recorded for this period.</p>
        ) : (
          <DataTable
            columns={[
              { key: 'month', label: 'Month' },
              { key: 'plan', label: 'Plan' },
              { key: 'vendor', label: 'Vendor' },
              { key: 'seats', label: 'Seats' },
              { key: 'unit', label: 'Unit $' },
              { key: 'total', label: 'Total', align: 'right' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={tableRows}
          />
        )}
      </Card>
    </>
  );
}

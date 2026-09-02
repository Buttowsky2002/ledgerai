'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, DataTable, PageHeader, Stat, usd } from '@/components/ui';
import { combinedAiCost } from '@/lib/combined-ai-cost';
import {
  AI_VENDORS,
  PLAN_TIERS,
  PLAN_TIER_BUTTON_LABELS,
  costTypeForTier,
  defaultUnitUsd,
  lineItemFor,
  parseStoredPlan,
  vendorLabel,
  type PlanTier,
} from '@/lib/fixed-cost-catalog';
import { latestSeatByVendor, priorSeatEntryForVendor } from '@/lib/overview-seat-monthly';
import {
  createFixedCost,
  deleteFixedCost,
  fetchFixedCostRows,
  fetchMeteredSpend,
  fetchTotalCostOfAi,
  updateFixedCost,
} from '@/lib/api/fixed-costs';
import type { FixedCostRow, FixedCostType, FixedCostVendor } from '@/types/fixed-costs';
import {
  formatSeatDeltaSummary,
  formatSignedUsd,
  seatPriceDelta,
  type SeatPriceDelta,
  type SeatSnapshot,
} from '@/lib/seat-price-delta';

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
  if (!monthValue) {
    return '';
  }
  return `${monthValue}-01`;
}

type EditKey = {
  periodMonth: string;
  vendor: FixedCostVendor;
  costType: FixedCostType;
  lineItem?: string;
};

function snapshotFromForm(
  seats: string,
  unitCostUsd: string,
  costUsd: string,
): SeatSnapshot | null {
  const s = seats === '' ? 0 : Number(seats);
  const u = unitCostUsd === '' ? 0 : Number(unitCostUsd);
  const c = costUsd === '' ? 0 : Number(costUsd);
  if (!Number.isFinite(s) || !Number.isFinite(u) || !Number.isFinite(c)) {
    return null;
  }
  return { seats: s, unitCostUsd: u, costUsd: c };
}

function SeatImpactCallout({ delta }: { delta: SeatPriceDelta }) {
  const up = delta.usdDelta > 0 || (delta.usdDelta === 0 && delta.seatDelta > 0);
  const tone = up ? 'text-warn' : 'text-pos';
  const seatLine = delta.prior
    ? `${delta.prior.seats} → ${delta.current.seats} seats (${delta.seatDelta > 0 ? '+' : ''}${delta.seatDelta})`
    : `${delta.current.seats} seat${delta.current.seats === 1 ? '' : 's'}`;
  const costLine = delta.prior
    ? `${usd(delta.prior.costUsd)} → ${usd(delta.current.costUsd)}/mo (${formatSignedUsd(delta.usdDelta)})`
    : `${usd(delta.current.costUsd)}/mo`;
  return (
    <div className="rounded-lg border border-edge bg-canvas px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">Seat impact</p>
      <p className={`mt-1 num text-sm font-medium ${tone}`}>
        {seatLine} · {costLine}
      </p>
      {delta.usdFromSeats !== 0 && (
        <p className="mt-1 text-xs text-muted">
          {formatSignedUsd(delta.usdFromSeats)} from seats
          {delta.usdFromRate !== 0
            ? ` · ${formatSignedUsd(delta.usdFromRate)} from unit price`
            : ''}
        </p>
      )}
      {delta.usdFromSeats === 0 && delta.usdFromRate !== 0 && (
        <p className="mt-1 text-xs text-muted">
          {formatSignedUsd(delta.usdFromRate)} from unit price
        </p>
      )}
    </div>
  );
}

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
  const [vendor, setVendor] = useState<FixedCostVendor>('openai');
  const [planTier, setPlanTier] = useState<PlanTier>('team');
  const [billingMonth, setBillingMonth] = useState(() => monthInputValue(isoDate(new Date())));
  const [seats, setSeats] = useState('');
  const [unitCostUsd, setUnitCostUsd] = useState('');
  const [costUsd, setCostUsd] = useState('');
  const [costManual, setCostManual] = useState(false);
  const [customLineItem, setCustomLineItem] = useState('');
  const [note, setNote] = useState('');
  const [baseline, setBaseline] = useState<SeatSnapshot | null>(null);

  const lineItem = useMemo(
    () => lineItemFor(vendor, planTier, vendor === 'other' ? customLineItem : undefined),
    [vendor, planTier, customLineItem],
  );

  const vendorTotals = useMemo(() => [...latestSeatByVendor(rows).entries()], [rows]);

  const liveDelta = useMemo(() => {
    const current = snapshotFromForm(seats, unitCostUsd, costUsd);
    if (!current) {
      return null;
    }
    if (current.seats === 0 && current.costUsd === 0) {
      return null;
    }
    const delta = seatPriceDelta(current, baseline);
    if (delta.seatDelta === 0 && delta.usdDelta === 0) {
      return null;
    }
    return delta;
  }, [seats, unitCostUsd, costUsd, baseline]);

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
      if (loadErr) {
        setError(loadErr);
      }
    } finally {
      setLoading(false);
    }
  }, [rangeFrom, rangeTo]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (costManual) {
      return;
    }
    const s = Number(seats);
    const u = Number(unitCostUsd);
    if (
      seats !== '' &&
      unitCostUsd !== '' &&
      Number.isFinite(s) &&
      Number.isFinite(u) &&
      s >= 0 &&
      u >= 0
    ) {
      setCostUsd(String(s * u));
    }
  }, [seats, unitCostUsd, costManual]);

  useEffect(() => {
    if (editKey) {
      return;
    }
    const costType = costTypeForTier(planTier);
    const prior = priorSeatEntryForVendor(rows, vendor, {
      beforeMonth: billingMonth,
      lineItem,
      costType,
    });
    if (prior) {
      setSeats(prior.seats > 0 ? String(prior.seats) : '');
      setUnitCostUsd(prior.unit_cost_usd > 0 ? String(prior.unit_cost_usd) : '');
      setCostManual(false);
      setBaseline({
        seats: prior.seats,
        unitCostUsd: prior.unit_cost_usd,
        costUsd: prior.cost_usd,
      });
      return;
    }
    const def = defaultUnitUsd(vendor, planTier);
    setSeats('');
    if (def !== null) {
      setUnitCostUsd(String(def));
      if (planTier === 'free') {
        setCostUsd('0');
      }
    } else {
      setUnitCostUsd('');
    }
    setCostManual(false);
    setBaseline(null);
  }, [vendor, planTier, billingMonth, lineItem, rows, editKey]);

  function resetForm() {
    setEditKey(null);
    setVendor('openai');
    setPlanTier('team');
    setBillingMonth(monthInputValue(isoDate(new Date())));
    setSeats('');
    setUnitCostUsd('30');
    setCostUsd('');
    setCostManual(false);
    setCustomLineItem('');
    setNote('');
    setError(null);
    setBaseline(null);
  }

  function startEdit(row: FixedCostRow) {
    const parsed = parseStoredPlan(row.vendor, row.line_item || '', row.cost_type);

    setEditKey({
      periodMonth: String(row.period_month).slice(0, 10),
      vendor: row.vendor,
      costType: row.cost_type,
      lineItem: row.line_item || undefined,
    });
    setVendor(parsed.vendor);
    setPlanTier(parsed.tier);
    setBillingMonth(monthInputValue(String(row.period_month)));
    setSeats(row.seats > 0 ? String(row.seats) : '');
    setUnitCostUsd(row.unit_cost_usd > 0 ? String(row.unit_cost_usd) : '');
    setCostUsd(String(row.cost_usd));
    setCostManual(true);
    if (parsed.vendor === 'other') {
      setCustomLineItem(row.line_item || '');
    }
    setNote(row.note || '');
    setError(null);
    setSuccess(null);
    setBaseline({
      seats: row.seats > 0 ? row.seats : 0,
      unitCostUsd: row.unit_cost_usd > 0 ? row.unit_cost_usd : 0,
      costUsd: Number(row.cost_usd) || 0,
    });
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

    if (vendor === 'other' && !customLineItem.trim()) {
      setError('Enter a name for the custom vendor/plan.');
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

    const costType = costTypeForTier(planTier);
    const payload = {
      periodMonth,
      vendor,
      costType,
      costUsd: total,
      lineItem,
      seats: seatsNum,
      unitCostUsd: unitNum,
      note: note.trim() || undefined,
    };

    setSaving(true);
    try {
      const existingForMonth = rows.find(
        (row) =>
          monthInputValue(String(row.period_month)) === billingMonth &&
          row.vendor === vendor &&
          row.cost_type === costType &&
          (row.line_item || '') === lineItem,
      );

      const result = editKey
        ? await updateFixedCost({
            ...payload,
            periodMonth: editKey.periodMonth,
            vendor: editKey.vendor,
            costType: editKey.costType,
            lineItem: editKey.lineItem ?? payload.lineItem,
          })
        : existingForMonth
          ? await updateFixedCost({
              ...payload,
              periodMonth: String(existingForMonth.period_month).slice(0, 10),
              vendor: existingForMonth.vendor,
              costType: existingForMonth.cost_type,
              lineItem: existingForMonth.line_item || undefined,
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

      const current = snapshotFromForm(seats, unitCostUsd, costUsd);
      const delta = current ? seatPriceDelta(current, baseline) : null;
      const summary =
        delta && (delta.seatDelta !== 0 || delta.usdDelta !== 0)
          ? formatSeatDeltaSummary(delta)
          : null;
      setSuccess(
        (editKey ? 'Fixed overhead updated.' : 'Fixed overhead saved.') +
          (summary ? ` ${summary}` : ''),
      );
      resetForm();
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(row: FixedCostRow) {
    const label = `${String(row.period_month).slice(0, 7)} · ${row.line_item || vendorLabel(row.vendor)}`;
    if (!window.confirm(`Delete fixed overhead entry?\n\n${label}`)) {
      return;
    }

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
    plan: r.line_item || '—',
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
        subtitle="Seat licenses and subscriptions by vendor — rolls into Total cost of AI on Overview"
        actions={
          <Link href="/" className="text-sm text-muted hover:text-gray-200">
            Back to overview
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          label="Total cost of AI"
          value={usd(impact.total)}
          accent
          sub={`${rangeFrom} → ${rangeTo}`}
        />
        <Stat
          label="Attributable (metered)"
          value={usd(impact.attributable)}
          sub="Gateway & connector usage"
        />
        <Stat
          label="Fixed overhead"
          value={usd(impact.fixed)}
          tone="warn"
          sub={`${fixedPct.toFixed(1)}% of total in range`}
        />
      </div>

      {vendorTotals.length > 0 && (
        <Card
          title="Overhead by vendor"
          subtitle="Latest monthly run-rate per vendor — matches Overview"
        >
          <div className="flex flex-wrap gap-3">
            {vendorTotals.map(([vendor, snap]) => (
              <div
                key={vendor}
                className="min-w-[9rem] rounded-lg border border-edge bg-panel px-4 py-3"
              >
                <p className="text-xs text-muted">{vendorLabel(vendor)}</p>
                <p className="num text-lg font-semibold text-gray-100">{usd(snap.seat_usd)}/mo</p>
                {snap.tiers
                  .filter((t) => t.seats > 0 || t.seat_usd > 0)
                  .map((t) => (
                    <p key={t.class} className="mt-0.5 text-xs text-muted">
                      {t.seats} {t.class}
                      {t.unit_usd > 0 ? ` · ${usd(t.unit_usd)}/seat` : ''}
                    </p>
                  ))}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title={editKey ? 'Edit entry' : 'Add seats & plan'} subtitle={`Saving as: ${lineItem}`}>
        {!editKey && baseline && (
          <p className="mb-4 text-xs text-muted">
            Pre-filled from {String(baseline.seats)} seats · {usd(baseline.costUsd)}/mo in the prior
            billing month — adjust if seats or price changed.
          </p>
        )}
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-5">
          <div>
            <span className="mb-2 block text-sm text-muted">Vendor</span>
            <div className="flex flex-wrap gap-2">
              {AI_VENDORS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  disabled={!!editKey}
                  onClick={() => setVendor(v.id)}
                  className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                    vendor === v.id
                      ? 'border-accent bg-accent/20 text-white'
                      : 'border-edge text-muted hover:border-accent/40 hover:text-gray-200'
                  } disabled:opacity-50`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-2 block text-sm text-muted">Plan tier</span>
            <div className="inline-flex rounded-lg border border-edge p-1">
              {PLAN_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  disabled={!!editKey}
                  onClick={() => setPlanTier(tier)}
                  className={`rounded-md px-4 py-2 text-sm capitalize ${
                    planTier === tier ? 'bg-accent/25 text-white' : 'text-muted hover:text-gray-200'
                  } disabled:opacity-50`}
                >
                  {PLAN_TIER_BUTTON_LABELS[tier]}
                </button>
              ))}
            </div>
            {planTier === 'premium' && (
              <p className="mt-2 text-xs text-muted">
                Premium is a separate seat class from Basic — both stay on Overview with their own
                seat count and price.
              </p>
            )}
            {planTier === 'enterprise' && (
              <p className="mt-2 text-xs text-muted">
                Enterprise is usually a custom contract — enter total cost manually.
              </p>
            )}
            {planTier === 'free' && (
              <p className="mt-2 text-xs text-muted">
                Free tier — cost defaults to $0 unless you track paid add-ons.
              </p>
            )}
          </div>

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

            {vendor === 'other' && (
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block text-muted">Custom plan name</span>
                <input
                  type="text"
                  className="w-full rounded border border-edge bg-canvas px-3 py-2 text-sm"
                  value={customLineItem}
                  onChange={(e) => setCustomLineItem(e.target.value)}
                  placeholder="e.g. Studio Designer AI Platform Team"
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
                placeholder={planTier === 'enterprise' ? 'Optional' : 'e.g. 10'}
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
                placeholder={
                  defaultUnitUsd(vendor, planTier) != null
                    ? String(defaultUnitUsd(vendor, planTier))
                    : 'Enter unit price'
                }
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

          {liveDelta && <SeatImpactCallout delta={liveDelta} />}

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

          {error && <p className="text-sm text-neg">{error}</p>}
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
              { key: 'vendor', label: 'Vendor' },
              { key: 'plan', label: 'Plan' },
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

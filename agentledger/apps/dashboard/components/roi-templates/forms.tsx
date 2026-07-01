'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';

const FIELD =
  'rounded border border-edge bg-ink px-2 py-1.5 text-sm text-gray-100 placeholder:text-muted focus:border-accent focus:outline-none';
const BTN = 'rounded bg-accent/20 px-3 py-1.5 text-sm text-white hover:bg-accent/30 disabled:opacity-50';

const OUTCOME_TYPES = ['pr_merged', 'ticket_resolved', 'issue_closed'];
const SOURCE_SYSTEMS = ['github', 'jira', 'zendesk', 'manual', 'api'];
const MATCH_ON = ['branch', 'user', 'issue'];

export function CreateRoiTemplate() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [outcomeType, setOutcomeType] = useState('ticket_resolved');
  const [sourceSystem, setSourceSystem] = useState('zendesk');
  const [hourlyRate, setHourlyRate] = useState('');
  const [baselineMinutes, setBaselineMinutes] = useState('');
  const [reworkPct, setReworkPct] = useState('');
  const [windowMinutes, setWindowMinutes] = useState('240');
  const [matchOn, setMatchOn] = useState<string[]>(['user']);

  function toggleMatch(m: string) {
    setMatchOn((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);

    const valueFormula: Record<string, number> = {
      hourly_rate: Number(hourlyRate),
      baseline_minutes: Number(baselineMinutes),
    };
    if (reworkPct !== '') valueFormula.rework_pct = Number(reworkPct);

    const attribution: Record<string, unknown> = { match_on: matchOn };
    if (windowMinutes !== '') attribution.window_minutes = Number(windowMinutes);

    const res = await fetch('/api/roi-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, outcomeType, sourceSystem, valueFormula, attribution }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(`Request failed (${res.status})`);
      return;
    }
    setName('');
    setHourlyRate('');
    setBaselineMinutes('');
    setReworkPct('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <input className={FIELD} placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} required />
        <select className={FIELD} value={outcomeType} onChange={(e) => setOutcomeType(e.target.value)}>
          {OUTCOME_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select className={FIELD} value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)}>
          {SOURCE_SYSTEMS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <fieldset className="flex flex-wrap items-end gap-2">
        <legend className="mb-1 text-xs uppercase tracking-wide text-muted">Value formula</legend>
        <label className="flex flex-col text-xs text-muted">
          hourly_rate
          <input className={FIELD} type="number" step="0.01" min="0" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} required />
        </label>
        <label className="flex flex-col text-xs text-muted">
          baseline_minutes
          <input className={FIELD} type="number" step="1" min="0" value={baselineMinutes} onChange={(e) => setBaselineMinutes(e.target.value)} required />
        </label>
        <label className="flex flex-col text-xs text-muted">
          rework_pct (0–1)
          <input className={FIELD} type="number" step="0.01" min="0" max="1" value={reworkPct} onChange={(e) => setReworkPct(e.target.value)} placeholder="optional" />
        </label>
      </fieldset>

      <fieldset className="flex flex-wrap items-end gap-4">
        <legend className="mb-1 text-xs uppercase tracking-wide text-muted">Attribution</legend>
        <label className="flex flex-col text-xs text-muted">
          window_minutes
          <input className={FIELD} type="number" step="1" min="1" value={windowMinutes} onChange={(e) => setWindowMinutes(e.target.value)} />
        </label>
        <div className="flex items-center gap-3 text-sm text-gray-100">
          {MATCH_ON.map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="checkbox" checked={matchOn.includes(m)} onChange={() => toggleMatch(m)} />
              {m}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-2">
        <button className={BTN} disabled={busy}>Create template</button>
        {err && <span className="text-xs text-neg">{err}</span>}
      </div>
    </form>
  );
}

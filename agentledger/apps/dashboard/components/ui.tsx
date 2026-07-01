import { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent/80">{eyebrow}</div>
        )}
        <h1 className="text-[26px] font-semibold leading-none tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-edge bg-panel shadow-card">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-4 border-b border-edge/70 px-5 py-3.5">
          <div>
            {title && <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-200">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Tone = 'default' | 'pos' | 'neg' | 'warn';
const TONE_TEXT: Record<Tone, string> = {
  default: 'text-gray-50',
  pos: 'text-pos',
  neg: 'text-neg',
  warn: 'text-warn',
};

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
  accent = false,
  chart,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: Tone;
  accent?: boolean;
  chart?: ReactNode;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-edge bg-panel p-5 shadow-card transition-colors hover:border-edge/60">
      {accent && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />
      )}
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`num mt-2 text-[28px] font-semibold leading-none ${TONE_TEXT[tone]}`}>{value}</div>
      {sub && <div className="mt-2 text-xs text-muted">{sub}</div>}
      {chart && <div className="-mx-1 mt-3">{chart}</div>}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'pos' | 'neg' | 'warn' | 'info';
const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-white/[0.06] text-muted ring-white/10',
  pos: 'bg-pos/10 text-pos ring-pos/20',
  neg: 'bg-neg/10 text-neg ring-neg/20',
  warn: 'bg-warn/10 text-warn ring-warn/20',
  info: 'bg-accent/10 text-accent ring-accent/20',
};

export function Badge({ tone = 'neutral', dot = false, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONE[tone]}`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export interface Column {
  key: string;
  label: string;
  align?: 'right';
}

export function DataTable({ columns, rows }: { columns: Column[]; rows: Record<string, ReactNode>[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'text-right' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-10 text-center text-muted">
                No data
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'text-right' : ''}>
                    {/* Right-aligned columns are numeric by convention — render them in
                        the tabular mono house style automatically. */}
                    {c.align === 'right' ? <span className="num">{r[c.key]}</span> : r[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function usd(n: number | string | undefined): string {
  const v = typeof n === 'string' ? Number(n) : (n ?? 0);
  return `$${(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n: number | string | undefined): string {
  const v = typeof n === 'string' ? Number(n) : (n ?? 0);
  return (v || 0).toLocaleString('en-US');
}

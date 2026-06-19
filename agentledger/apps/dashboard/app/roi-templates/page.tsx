import { CreateRoiTemplate } from '../../components/roi-templates/forms';
import { DeleteButton } from '../../components/settings/DeleteButton';
import { Card, DataTable, PageHeader } from '../../components/ui';
import { apiClient, fetchData } from '../../lib/api';

export const dynamic = 'force-dynamic';

type ValueFormula = { hourly_rate?: number; baseline_minutes?: number; rework_pct?: number };
type Attribution = { window_minutes?: number; match_on?: string[] };
type RoiTemplate = {
  templateId: string;
  tenantId: string | null;
  name: string;
  outcomeType: string;
  sourceSystem: string;
  valueFormula: ValueFormula;
  attribution: Attribution;
};

function formulaSummary(f: ValueFormula): string {
  const parts: string[] = [];
  if (f.hourly_rate != null) parts.push(`$${f.hourly_rate}/h`);
  if (f.baseline_minutes != null) parts.push(`${f.baseline_minutes}m`);
  if (f.rework_pct != null) parts.push(`${Math.round(f.rework_pct * 100)}% rework`);
  return parts.join(' · ') || '—';
}

export default async function RoiTemplatesPage() {
  const api = apiClient();
  const templates = (await fetchData(
    api.GET('/v1/roi-templates', { params: { query: { limit: '100', offset: '0' } } }),
    [],
  )) as unknown as RoiTemplate[];

  return (
    <>
      <PageHeader title="ROI templates" subtitle="Value formulas + attribution overrides per outcome type" />
      <Card title="Create template">
        <CreateRoiTemplate />
      </Card>
      <Card title="Templates">
        <DataTable
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'outcome', label: 'Outcome type' },
            { key: 'source', label: 'Source' },
            { key: 'formula', label: 'Value formula' },
            { key: 'window', label: 'Window (min)', align: 'right' },
            { key: 'match', label: 'Match on' },
            { key: 'scope', label: 'Scope' },
            { key: 'actions', label: '' },
          ]}
          rows={templates.map((t) => ({
            name: t.name,
            outcome: t.outcomeType,
            source: t.sourceSystem,
            formula: formulaSummary(t.valueFormula ?? {}),
            window: t.attribution?.window_minutes ?? '—',
            match: (t.attribution?.match_on ?? []).join(', ') || '—',
            scope: t.tenantId ? 'tenant' : 'built-in',
            // Built-in packs (tenant_id NULL) are read-only under RLS — no delete control.
            actions: t.tenantId ? <DeleteButton url={`/api/roi-templates/${t.templateId}`} /> : null,
          }))}
        />
      </Card>
    </>
  );
}

import { proxyApi } from '@/lib/api';
import { resolveRange } from '@/lib/resolve-range';
import type { CursorSpendSummary } from '@/components/overview/CursorPlatformDetail';
import {
  VendorDetailSections,
  buildModelTableRows,
  type OrgVendorRow,
} from '@/components/vendors/VendorDetailSections';

export const dynamic = 'force-dynamic';

type ModelRow = { provider: string; model: string; cost_usd: number; calls: number };

export default async function VendorDetailPage({
  params,
  searchParams,
}: {
  params: { vendorId: string };
  searchParams: { from?: string; to?: string };
}) {
  const { from, to } = resolveRange(searchParams);
  const vendorId = decodeURIComponent(params.vendorId).trim().toLowerCase();
  const qs = new URLSearchParams({ from, to });

  const [billingRes, usersRes, modelMixRes, cursorRes] = await Promise.all([
    proxyApi(`/v1/analytics/vendor-billing?${qs.toString()}`),
    proxyApi(`/v1/analytics/users?${qs.toString()}`),
    proxyApi(`/v1/analytics/model-mix?${qs.toString()}`),
    vendorId === 'cursor'
      ? proxyApi(`/v1/analytics/cursor-spend?${qs.toString()}`)
      : Promise.resolve({ ok: false, data: null }),
  ]);

  const billing =
    billingRes.ok && billingRes.data && typeof billingRes.data === 'object'
      ? (billingRes.data as { vendors: OrgVendorRow[] })
      : { vendors: [] };
  const orgRow = billing.vendors.find((v) => v.vendor === vendorId) ?? null;
  const users =
    usersRes.ok && usersRes.data && typeof usersRes.data === 'object'
      ? ((usersRes.data as { users: unknown[] }).users ?? [])
      : [];
  const modelMix = (
    modelMixRes.ok && Array.isArray(modelMixRes.data) ? modelMixRes.data : []
  ) as ModelRow[];
  const models = modelMix.map((r) => ({
    provider: r.provider,
    model: r.model,
    cost_usd: Number(r.cost_usd),
    calls: Number(r.calls),
  }));
  const cursorSpend: CursorSpendSummary | null =
    cursorRes.ok && cursorRes.data && typeof cursorRes.data === 'object'
      ? (cursorRes.data as CursorSpendSummary)
      : null;

  const modelRows = buildModelTableRows(models, cursorSpend, vendorId);

  return (
    <VendorDetailSections
      vendorId={vendorId}
      from={from}
      to={to}
      orgRow={orgRow}
      users={users as Parameters<typeof VendorDetailSections>[0]['users']}
      modelRows={modelRows}
      cursorSpend={cursorSpend}
      cursorSpendError={vendorId === 'cursor' && !cursorRes.ok}
    />
  );
}

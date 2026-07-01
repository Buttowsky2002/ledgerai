import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

type SpendRow = { cost_usd: number | string };

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const path = qs ? `/v1/analytics/spend?${qs}` : '/v1/analytics/spend';
  const { ok, status, data } = await proxyApi(path);
  if (!ok) {
    return NextResponse.json({ totalUsd: 0 }, { status: status >= 400 ? status : 502 });
  }
  const rows = Array.isArray(data) ? (data as SpendRow[]) : [];
  const totalUsd = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  return NextResponse.json({ totalUsd });
}

import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const path = qs ? `/v1/analytics/source-reconciliation?${qs}` : '/v1/analytics/source-reconciliation';
  const { ok, status, data } = await proxyApi(path);
  if (!ok) {
    return NextResponse.json(data ?? { error: 'reconciliation failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

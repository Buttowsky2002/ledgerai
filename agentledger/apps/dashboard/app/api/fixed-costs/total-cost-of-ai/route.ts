import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const path = qs ? `/v1/fixed-costs/total-cost-of-ai?${qs}` : '/v1/fixed-costs/total-cost-of-ai';
  const { ok, status, data } = await proxyApi(path);
  if (!ok) {
    return NextResponse.json(data ?? { error: 'total cost failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

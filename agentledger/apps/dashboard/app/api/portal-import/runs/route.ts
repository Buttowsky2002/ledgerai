import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get('limit');
  const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  const { ok, status, data } = await proxyApi(`/v1/portal-import/runs${qs}`);
  if (!ok) {
    return NextResponse.json(data ?? { error: 'failed to load import runs' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

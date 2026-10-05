import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** GET FinOps teams for assignment pickers. */
export async function GET() {
  const { ok, status, data } = await proxyApi('/v1/teams?limit=200');
  if (!ok) {
    return NextResponse.json(data ?? { error: 'teams load failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET() {
  const { ok, status, data } = await proxyApi('/v1/tenant');
  if (!ok) {
    return NextResponse.json(data ?? { error: 'tenant fetch failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/tenant', {
    method: 'PATCH',
    body,
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'tenant update failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

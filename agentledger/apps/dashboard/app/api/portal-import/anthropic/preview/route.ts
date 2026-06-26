import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/portal-import/anthropic/preview', {
    method: 'POST',
    body,
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'preview failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

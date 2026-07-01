import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/portal-import/anthropic', {
    method: 'POST',
    body,
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'upload failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

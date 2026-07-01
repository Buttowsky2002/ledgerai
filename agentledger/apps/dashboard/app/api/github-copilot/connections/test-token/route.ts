import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function POST(req: Request) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/github-copilot/connections/test-token', {
    method: 'POST',
    body,
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'test failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

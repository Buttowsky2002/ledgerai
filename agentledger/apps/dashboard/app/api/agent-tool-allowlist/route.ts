import { NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

/** GET / POST agent tool allowlist (CISO governance). */
export async function GET() {
  const { ok, status, data } = await proxyApi('/v1/agent-tool-allowlist?limit=200&offset=0');
  if (!ok) {
    return NextResponse.json(data ?? { error: 'list failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/agent-tool-allowlist', {
    method: 'POST',
    body,
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'create failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data, { status: 201 });
}

import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '../../../lib/api';

export async function GET() {
  const { ok, status, data } = await proxyApi('/v1/connectors?limit=100&offset=0');
  if (!ok) return NextResponse.json(data ?? { error: 'list failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/connectors', {
    method: 'POST',
    body,
  });
  if (!ok) return NextResponse.json(data ?? { error: 'create failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

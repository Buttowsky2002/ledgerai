import { NextResponse } from 'next/server';
import { proxyApi } from '../../../../../lib/api';

type Params = { params: { id: string } };

export async function GET(_req: Request, { params }: Params) {
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}/attribution-mappings`);
  if (!ok) return NextResponse.json(data ?? { error: 'request failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

export async function POST(req: Request, { params }: Params) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}/attribution-mappings`, {
    method: 'POST',
    body: body || '{}',
  });
  if (!ok) return NextResponse.json(data ?? { error: 'request failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

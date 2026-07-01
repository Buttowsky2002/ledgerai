import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '../../../../lib/api';

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}`);
  if (!ok) return NextResponse.json({ error: 'get failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}`, { method: 'PATCH', body });
  if (!ok) return NextResponse.json({ error: 'update failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}`, { method: 'DELETE' });
  if (!ok) return NextResponse.json(data ?? { error: 'delete failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

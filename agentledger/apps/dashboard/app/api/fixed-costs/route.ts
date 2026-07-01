import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const path = qs ? `/v1/fixed-costs?${qs}` : '/v1/fixed-costs';
  const { ok, status, data } = await proxyApi(path);
  if (!ok) {
    return NextResponse.json(data ?? { error: 'list failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/fixed-costs', { method: 'POST', body });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'create failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/fixed-costs', { method: 'PATCH', body });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'update failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const body = await req.text();
  const { ok, status, data } = await proxyApi('/v1/fixed-costs', { method: 'DELETE', body });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'delete failed' }, { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data ?? { ok: true });
}

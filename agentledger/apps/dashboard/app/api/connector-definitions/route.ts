import { NextResponse } from 'next/server';
import { proxyApi } from '../../../lib/api';

export async function GET() {
  const { ok, status, data } = await proxyApi('/v1/connector-definitions');
  if (!ok) return NextResponse.json({ error: 'list failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

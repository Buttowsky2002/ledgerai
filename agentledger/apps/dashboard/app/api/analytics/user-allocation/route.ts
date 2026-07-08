import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function GET(req: NextRequest) {
  const params = new URLSearchParams(req.nextUrl.searchParams);
  if (!params.has('dimension')) params.set('dimension', 'user');
  const { ok, status, data } = await proxyApi(`/v1/analytics/allocation?${params.toString()}`);
  if (!ok) {
    return NextResponse.json([], { status: status >= 400 ? status : 502 });
  }
  return NextResponse.json(data ?? []);
}

import { NextRequest, NextResponse } from 'next/server';
import { apiAuthHeaders } from '@/lib/api';
import { env } from '@/lib/env';

const API_URL = env('BADGERIQ_API_URL') ?? 'http://localhost:8094';

/** Proxy executive report binary export (PDF / XLSX) from the control-plane API. */
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const path = `/v1/reports/executive${qs ? `?${qs}` : ''}`;
  const res = await fetch(`${API_URL}${path}`, { headers: apiAuthHeaders() });
  if (!res.ok) {
    const text = await res.text();
    try {
      return NextResponse.json(JSON.parse(text), { status: res.status });
    } catch {
      return NextResponse.json({ error: text.slice(0, 500) }, { status: res.status });
    }
  }
  const body = await res.arrayBuffer();
  const headers = new Headers();
  headers.set('Content-Type', res.headers.get('content-type') ?? 'application/octet-stream');
  const cd = res.headers.get('content-disposition');
  if (cd) headers.set('Content-Disposition', cd);
  return new NextResponse(body, { status: 200, headers });
}

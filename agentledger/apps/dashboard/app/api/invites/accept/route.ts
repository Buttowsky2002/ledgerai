import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';

/** Public BFF — no session cookie; forwards to NestJS invite accept endpoints. */
const API_BASE = env('BADGERIQ_API_URL') ?? 'http://localhost:8094';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const upstream = await fetch(`${API_BASE}/v1/invites/accept?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await upstream.json().catch(() => ({}));
  return NextResponse.json(body, { status: upstream.status });
}

export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => ({}));
  const upstream = await fetch(`${API_BASE}/v1/invites/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await upstream.json().catch(() => ({}));
  return NextResponse.json(body, { status: upstream.status });
}

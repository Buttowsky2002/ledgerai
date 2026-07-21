import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const API_URL = env('BADGERIQ_API_URL') ?? 'http://localhost:8094';

/**
 * Readiness (Cloud Run contract): ready only when the control-plane API is —
 * the API's /ready in turn verifies its Postgres (and, when configured,
 * ClickHouse) connectivity. The endpoint is public on the API, so no auth.
 */
export async function GET() {
  const url = `${API_URL}/ready`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(body, { status: res.status });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { cause?: unknown };
    console.error('[dashboard] /ready: API fetch failed', {
      url,
      apiUrl: API_URL,
      message: e?.message ?? String(err),
      code: e?.code,
      cause: e?.cause,
      name: e?.name,
      stack: e?.stack,
    });
    return NextResponse.json(
      { status: 'api unreachable', url, error: e?.message ?? String(err), code: e?.code },
      { status: 503 },
    );
  }
}

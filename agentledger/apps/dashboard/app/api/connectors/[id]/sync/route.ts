import { NextResponse } from 'next/server';
import { proxyApi } from '../../../../../lib/api';

type Params = { params: { id: string } };

/** Long-running provider backfills (Cursor pagination + multi-chunk Anthropic). */
export const maxDuration = 600;

export async function POST(req: Request, { params }: Params) {
  let body: { from?: string; to?: string } = {};
  const raw = await req.text();
  if (raw) {
    try {
      body = JSON.parse(raw) as { from?: string; to?: string };
    } catch {
      return NextResponse.json({ message: 'invalid JSON body' }, { status: 400 });
    }
  }

  const from = body.from?.slice(0, 10);
  const to = body.to?.slice(0, 10);
  if (from && to && from > to) {
    return NextResponse.json({ message: 'from must be on or before to' }, { status: 400 });
  }

  const payload = from && to ? { from, to } : {};

  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!ok) {
    return NextResponse.json((data ?? { message: 'sync failed' }) as Record<string, unknown>, {
      status: status >= 400 ? status : 502,
    });
  }

  return NextResponse.json(data ?? {});
}

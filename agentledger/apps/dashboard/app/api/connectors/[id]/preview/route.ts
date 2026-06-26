import { NextResponse } from 'next/server';
import { proxyApi } from '../../../../../lib/api';
import { previewDateRange } from '../../../../../lib/sync-date-chunks';

type Params = { params: { id: string } };

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
  const clipped =
    from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)
      ? previewDateRange(from, to)
      : body;

  const { ok, status, data } = await proxyApi(`/v1/connectors/${params.id}/preview`, {
    method: 'POST',
    body: JSON.stringify(clipped),
  });
  if (!ok) return NextResponse.json(data ?? { error: 'preview failed' }, { status: status >= 400 ? status : 502 });
  return NextResponse.json(data);
}

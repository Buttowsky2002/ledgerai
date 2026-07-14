import { NextRequest, NextResponse } from 'next/server';
import { proxyApi } from '@/lib/api';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { runId: string } },
) {
  const runId = decodeURIComponent(params.runId);
  const { ok, status, data } = await proxyApi(`/v1/portal-import/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
  if (!ok) {
    return NextResponse.json(data ?? { error: 'delete failed' }, {
      status: status >= 400 ? status : 502,
    });
  }
  return NextResponse.json(data);
}

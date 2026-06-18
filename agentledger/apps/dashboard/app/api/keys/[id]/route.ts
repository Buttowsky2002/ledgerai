import { NextResponse } from 'next/server';
import { apiClient } from '../../../../lib/api';

// Revoke (soft-delete) a virtual key.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { error } = await apiClient().DELETE('/v1/virtual-keys/{id}', {
    params: { path: { id: params.id } },
  });
  if (error) {
    return NextResponse.json({ error: 'revoke failed' }, { status: 502 });
  }
  return new NextResponse(null, { status: 204 });
}

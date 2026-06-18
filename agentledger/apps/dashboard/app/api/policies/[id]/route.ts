import { NextResponse } from 'next/server';
import { apiClient } from '../../../../lib/api';

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { error } = await apiClient().DELETE('/v1/policies/{id}', {
    params: { path: { id: params.id } },
  });
  if (error) {
    return NextResponse.json({ error: 'delete failed' }, { status: 502 });
  }
  return new NextResponse(null, { status: 204 });
}

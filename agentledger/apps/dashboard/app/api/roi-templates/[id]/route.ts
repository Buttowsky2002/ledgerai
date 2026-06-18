import { NextRequest, NextResponse } from 'next/server';
import { apiClient } from '../../../../lib/api';

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { data, error } = await apiClient().PATCH('/v1/roi-templates/{id}', {
    params: { path: { id: params.id } },
    body,
  });
  if (error) {
    return NextResponse.json({ error: 'update failed' }, { status: 502 });
  }
  return NextResponse.json(data);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { error } = await apiClient().DELETE('/v1/roi-templates/{id}', {
    params: { path: { id: params.id } },
  });
  if (error) {
    return NextResponse.json({ error: 'delete failed' }, { status: 502 });
  }
  return new NextResponse(null, { status: 204 });
}

import { NextResponse } from 'next/server';
import { apiClient } from '../../../../../lib/api';

/** Revoke a SCIM bearer token (admin). */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const { data, error, response } = await apiClient().POST('/v1/scim-tokens/{id}/revoke', {
    params: { path: { id: params.id } },
  });
  if (error) {
    return NextResponse.json(
      { error: 'revoke failed' },
      { status: response.status || 502 },
    );
  }
  return NextResponse.json(data);
}

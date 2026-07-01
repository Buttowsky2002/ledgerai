import { NextResponse } from 'next/server';
import { apiClient } from '../../../../../lib/api';

// Revoke a SCIM bearer token — the IdP using it can no longer authenticate to /scim/v2.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const { error } = await apiClient().POST('/v1/scim-tokens/{id}/revoke', {
    params: { path: { id: params.id } },
  });
  if (error) {
    return NextResponse.json({ error: 'revoke failed' }, { status: 502 });
  }
  return new NextResponse(null, { status: 204 });
}

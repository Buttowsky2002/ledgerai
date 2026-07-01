import { NextRequest, NextResponse } from 'next/server';
import { apiClient } from '../../../lib/api';

// Issue a SCIM bearer token — the response includes the plaintext `token` exactly once.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await apiClient().POST('/v1/scim-tokens', { body });
  if (error) {
    return NextResponse.json({ error: 'issue failed' }, { status: 502 });
  }
  return NextResponse.json(data);
}

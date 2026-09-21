import { NextRequest, NextResponse } from 'next/server';
import { apiClient } from '../../../lib/api';

/** Create a per-tenant OIDC IdP config (SSO). */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error, response } = await apiClient().POST('/v1/tenant-idp-config', { body });
  if (error) {
    return NextResponse.json(
      { error: 'create failed' },
      { status: response.status || 502 },
    );
  }
  return NextResponse.json(data);
}

import { NextRequest, NextResponse } from 'next/server';
import { apiClient } from '../../../lib/api';

// Create a per-tenant OIDC IdP config. clientSecretRef is a *reference* (env-var / SM
// secret name), never the secret value — the API stores only the reference.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await apiClient().POST('/v1/tenant-idp-config', { body });
  if (error) {
    return NextResponse.json({ error: 'create failed' }, { status: 502 });
  }
  return NextResponse.json(data);
}

import { NextRequest, NextResponse } from 'next/server';
import { apiClient } from '../../../lib/api';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await apiClient().POST('/v1/budgets', { body });
  if (error) {
    return NextResponse.json({ error: 'create failed' }, { status: 502 });
  }
  return NextResponse.json(data);
}

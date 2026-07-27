import { proxyApiServer } from '@/lib/api';

export async function POST(req: Request) {
  const body = await req.json();
  return proxyApiServer('POST', '/v1/invites', body);
}

export async function GET() {
  return proxyApiServer('GET', '/v1/invites');
}

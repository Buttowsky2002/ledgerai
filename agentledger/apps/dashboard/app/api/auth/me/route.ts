import { proxyApiServer } from '@/lib/api';

export async function GET() {
  return proxyApiServer('GET', '/auth/me');
}

export async function PATCH(req: Request) {
  const body = await req.json();
  return proxyApiServer('PATCH', '/auth/me', body);
}

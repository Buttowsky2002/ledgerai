import { proxyApiServer } from '@/lib/api';

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return proxyApiServer('DELETE', `/v1/invites/${encodeURIComponent(params.id)}`);
}

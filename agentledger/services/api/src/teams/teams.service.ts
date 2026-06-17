import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';

/**
 * Minimal read surface over an RLS-protected table. Exists in this slice purely
 * to make tenant isolation *observable* end-to-end; full CRUD arrives in the
 * resources task. Note there is no `where: { tenantId }` filter here — isolation
 * is enforced by Postgres RLS via the tenant-scoped transaction, not by app code.
 */
@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const tenantId = getTenantId();
    const teams = await this.prisma.withTenant(tenantId, (tx) =>
      tx.team.findMany({ orderBy: { name: 'asc' } }),
    );
    return teams.map((t) => ({
      teamId: t.teamId,
      name: t.name,
      costCenter: t.costCenter,
      parentTeamId: t.parentTeamId,
    }));
  }
}

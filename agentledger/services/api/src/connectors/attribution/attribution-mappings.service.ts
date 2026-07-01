import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { getTenantId } from '../../tenant/tenant-context';
import { recordAudit } from '../../common/audit';
import type { AttributionMapping, MappingType } from './attribution-resolver';

export interface CreateAttributionMappingDto {
  connectorId: string;
  mappingType: MappingType;
  providerKey: string;
  providerKeyName?: string;
  targetUserId?: string;
  targetTeamId?: string;
}

@Injectable()
export class AttributionMappingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(connectorId?: string): Promise<AttributionMapping[]> {
    const tenantId = getTenantId();
    const rows = await this.prisma.withTenant(tenantId!, (tx) =>
      tx.connectorAttributionMapping.findMany({
        where: connectorId ? { connectorId } : {},
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((r) => ({
      mappingType: r.mappingType as MappingType,
      providerKey: r.providerKey,
      targetUserId: r.targetUserId,
      targetTeamId: r.targetTeamId,
    }));
  }

  async create(dto: CreateAttributionMappingDto) {
    const tenantId = getTenantId();
    return this.prisma.withTenant(tenantId!, async (tx) => {
      const created = await tx.connectorAttributionMapping.upsert({
        where: {
          tenantId_connectorId_mappingType_providerKey: {
            tenantId: tenantId!,
            connectorId: dto.connectorId,
            mappingType: dto.mappingType,
            providerKey: dto.providerKey,
          },
        },
        create: {
          tenantId: tenantId!,
          connectorId: dto.connectorId,
          mappingType: dto.mappingType,
          providerKey: dto.providerKey,
          providerKeyName: dto.providerKeyName,
          targetUserId: dto.targetUserId,
          targetTeamId: dto.targetTeamId,
        },
        update: {
          providerKeyName: dto.providerKeyName,
          targetUserId: dto.targetUserId,
          targetTeamId: dto.targetTeamId,
          updatedAt: new Date(),
        },
      });
      await recordAudit(tx, {
        action: 'create',
        object: `connector_attribution_mapping:${created.mappingId}`,
        before: null,
        after: created,
      });
      return created;
    });
  }

  async delete(mappingId: string) {
    const tenantId = getTenantId();
    return this.prisma.withTenant(tenantId!, async (tx) => {
      const before = await tx.connectorAttributionMapping.findUnique({ where: { mappingId } });
      if (!before) throw new NotFoundException('mapping not found');
      await tx.connectorAttributionMapping.delete({ where: { mappingId } });
      await recordAudit(tx, {
        action: 'delete',
        object: `connector_attribution_mapping:${mappingId}`,
        before,
        after: null,
      });
      return { deleted: true };
    });
  }

  async loadForConnector(connectorId: string): Promise<AttributionMapping[]> {
    const tenantId = getTenantId();
    const rows = await this.prisma.withTenant(tenantId!, (tx) =>
      tx.connectorAttributionMapping.findMany({
        where: { connectorId },
      }),
    );
    return rows.map((r) => ({
      mappingType: r.mappingType as MappingType,
      providerKey: r.providerKey,
      targetUserId: r.targetUserId,
      targetTeamId: r.targetTeamId,
    }));
  }
}

import { Body, Controller, Get, NotFoundException, Patch } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsIn, IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { recordAudit } from '../common/audit';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from './tenant-context';

const PLANS = ['trial', 'team', 'enterprise'];
const CONTENT_CAPTURE = ['metadata_only', 'redacted', 'full'];

class UpdateTenantDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsIn(PLANS) plan?: string;
  @IsOptional() @IsInt() retentionDays?: number;
  @IsOptional() @IsIn(CONTENT_CAPTURE) contentCapture?: string;
  @IsOptional() @IsObject() complianceFlags?: Record<string, unknown>;
}

/**
 * The caller's own tenant. RLS confines visibility to a single row, so these
 * operate on "my tenant" with no id param. Tenant provisioning (create/delete) is
 * a cross-tenant operation RLS blocks and is out of scope here (see ADR-012).
 */
@Controller('v1/tenant')
export class TenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('viewer') @Get()
  async current() {
    const row = await this.prisma.withTenant(getTenantId(), (tx) => tx.tenant.findFirst());
    if (!row) {
      throw new NotFoundException('tenant not found');
    }
    return row;
  }

  @Roles('admin') @Patch()
  async update(@Body() dto: UpdateTenantDto) {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const before = await tx.tenant.findFirst();
      if (!before) {
        throw new NotFoundException('tenant not found');
      }
      const after = await tx.tenant.update({
        where: { tenantId: before.tenantId },
        data: {
          ...dto,
          complianceFlags: dto.complianceFlags as Prisma.InputJsonValue | undefined,
        },
      });
      await recordAudit(tx, {
        action: 'update',
        object: `tenant:${before.tenantId}`,
        before,
        after,
      });
      return after;
    });
  }
}

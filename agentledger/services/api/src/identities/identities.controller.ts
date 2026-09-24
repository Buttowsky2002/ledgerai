import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../auth/decorators';
import { recordAudit } from '../common/audit';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';

const ROLES = ['member', 'admin', 'finance', 'security'];
const API_ROLES = ['viewer', 'analyst', 'admin'];
const SEAT_TIERS = ['none', 'basic', 'premium'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CreateIdentityDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsIn(ROLES) role?: string;
  @IsOptional() @IsIn(API_ROLES) apiRole?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsArray() aliases?: unknown[];
}

class UpdateIdentityDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsIn(ROLES) role?: string;
  @IsOptional() @IsIn(API_ROLES) apiRole?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsArray() aliases?: unknown[];
}

class SeatTierItemDto {
  @IsString() vendor!: string;
  @IsIn(SEAT_TIERS) tier!: (typeof SEAT_TIERS)[number];
}

class PatchSeatTiersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SeatTierItemDto)
  tiers!: SeatTierItemDto[];
}

@Controller('v1/identities')
export class IdentitiesController {
  private readonly crud: CrudService;
  constructor(private readonly prisma: PrismaService) {
    this.crud = new CrudService(prisma, {
      model: 'identity',
      idField: 'userId',
      object: 'identity',
    });
  }

  @Roles('viewer')
  @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.crud.list(parsePagination(limit, offset));
  }

  @Roles('viewer')
  @Get(':id/seat-tiers')
  async listSeatTiers(@Param('id') id: string) {
    const identity = await this.resolveIdentity(id);
    const rows = await this.prisma.withTenant(getTenantId(), (tx) =>
      tx.identitySeatTier.findMany({
        where: { userId: identity.userId },
        orderBy: { vendor: 'asc' },
      }),
    );
    return {
      user_id: identity.userId,
      email: identity.email,
      tiers: rows.map((r) => ({ vendor: r.vendor, tier: r.tier })),
    };
  }

  @Roles('analyst')
  @Patch(':id/seat-tiers')
  async patchSeatTiers(@Param('id') id: string, @Body() dto: PatchSeatTiersDto) {
    if (!dto.tiers || !Array.isArray(dto.tiers)) {
      throw new BadRequestException('tiers array required');
    }
    const identity = await this.resolveIdentity(id);
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const normalized = dto.tiers.map((t) => {
      const raw = String(t.tier ?? '')
        .trim()
        .toLowerCase();
      const tier: (typeof SEAT_TIERS)[number] =
        raw === 'none' ? 'none' : raw === 'premium' ? 'premium' : 'basic';
      return {
        vendor: String(t.vendor).trim().toLowerCase(),
        tier,
      };
    });
    for (const t of normalized) {
      if (!t.vendor) {
        throw new BadRequestException('vendor required');
      }
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.identitySeatTier.findMany({
        where: { userId: identity.userId },
      });
      // Persist basic and premium so seat-only licenses create presence.
      // "none" clears the vendor license (no Fixed Overhead seat share).
      for (const t of normalized) {
        if (t.tier === 'none') {
          await tx.identitySeatTier.deleteMany({
            where: { userId: identity.userId, vendor: t.vendor },
          });
          continue;
        }
        await tx.identitySeatTier.upsert({
          where: {
            tenantId_userId_vendor: {
              tenantId,
              userId: identity.userId,
              vendor: t.vendor,
            },
          },
          create: {
            tenantId,
            userId: identity.userId,
            vendor: t.vendor,
            tier: t.tier,
          },
          update: { tier: t.tier },
        });
      }
      const after = await tx.identitySeatTier.findMany({
        where: { userId: identity.userId },
      });
      await recordAudit(tx, {
        action: 'update',
        object: `identity_seat_tiers:${identity.userId}`,
        before: before.map((r) => ({ vendor: r.vendor, tier: r.tier })),
        after: after.map((r) => ({ vendor: r.vendor, tier: r.tier })),
      });
      return {
        user_id: identity.userId,
        email: identity.email,
        tiers: after.map((r) => ({ vendor: r.vendor, tier: r.tier })),
      };
    });
  }

  @Roles('viewer')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.crud.get(id);
  }

  @Roles('admin')
  @Post()
  create(@Body() dto: CreateIdentityDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateIdentityDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }

  /** Resolve directory key (UUID or email) to an identity row. */
  private async resolveIdentity(id: string): Promise<{ userId: string; email: string }> {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new BadRequestException('no tenant in context');
    }
    const trimmed = id.trim();
    const row = await this.prisma.withTenant(tenantId, async (tx) => {
      if (UUID_RE.test(trimmed)) {
        return tx.identity.findUnique({
          where: { userId: trimmed },
          select: { userId: true, email: true },
        });
      }
      return tx.identity.findFirst({
        where: { email: { equals: trimmed, mode: 'insensitive' } },
        select: { userId: true, email: true },
      });
    });
    if (!row) {
      throw new NotFoundException('identity not found');
    }
    return row;
  }
}

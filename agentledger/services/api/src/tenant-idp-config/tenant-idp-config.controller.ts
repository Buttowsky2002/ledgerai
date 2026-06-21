import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateTenantIdpDto {
  @IsString() issuer!: string;
  @IsString() clientId!: string;
  // A reference (env-var name / KMS-vault key), never the secret itself (rules 1, 9).
  @IsString() clientSecretRef!: string;
  @IsArray() @IsString({ each: true }) emailDomains!: string[];
  @IsOptional() @IsIn(['oidc']) protocol?: string;
  @IsOptional() @IsBoolean() jitEnabled?: boolean;
  @IsOptional() @IsIn(['viewer', 'analyst', 'admin']) defaultApiRole?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateTenantIdpDto {
  @IsOptional() @IsString() issuer?: string;
  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsString() clientSecretRef?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) emailDomains?: string[];
  @IsOptional() @IsBoolean() jitEnabled?: boolean;
  @IsOptional() @IsIn(['viewer', 'analyst', 'admin']) defaultApiRole?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/**
 * Per-tenant OIDC IdP configuration for enterprise SSO (P6-D1, ADR-033). Admin-only:
 * this is security-sensitive identity config. Postgres is the source of truth (RLS,
 * audit via CrudService). The secret is referenced by name (client_secret_ref),
 * never stored here in plaintext (rules 1, 9).
 */
@Controller('v1/tenant-idp-config')
export class TenantIdpConfigController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, {
      model: 'tenantIdpConfig',
      idField: 'idpId',
      object: 'tenant_idp_config',
    });
  }

  @Roles('admin') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.crud.list(parsePagination(limit, offset));
  }

  @Roles('admin') @Get(':id')
  get(@Param('id') id: string) {
    return this.crud.get(id);
  }

  @Roles('admin') @Post()
  create(@Body() dto: CreateTenantIdpDto) {
    return this.crud.create({ ...dto, emailDomains: normalizeDomains(dto.emailDomains) });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTenantIdpDto) {
    const data: Record<string, unknown> = { ...dto };
    if (dto.emailDomains) {
      data.emailDomains = normalizeDomains(dto.emailDomains);
    }
    return this.crud.update(id, data);
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}

// Domains are matched case-insensitively at login (idp_lookup_by_domain lowercases
// the incoming domain), so store them lowercased and de-duplicated.
function normalizeDomains(domains: string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

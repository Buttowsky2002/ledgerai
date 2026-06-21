import { createHash, randomBytes } from 'node:crypto';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class IssueScimTokenDto {
  @IsString() name!: string;
}

interface ScimTokenRow {
  tokenId: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  [k: string]: unknown;
}

/**
 * Per-tenant SCIM bearer tokens (P6-D2). An IdP authenticates to /scim/v2 with one
 * of these. Postgres is the source of truth (RLS + audit, migration 009). The
 * secret is returned exactly once at issuance; only its SHA-256 hash is stored
 * (rule 6) — the same pattern as agent-credentials and virtual-keys. Admin only.
 */
@Controller('v1/scim-tokens')
export class ScimTokensController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'scimToken', idField: 'tokenId', object: 'scim_token' });
  }

  @Roles('admin') @Get()
  async list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const rows = (await this.crud.list(parsePagination(limit, offset))) as ScimTokenRow[];
    return rows.map(sanitize);
  }

  @Roles('admin') @Post()
  async issue(@Body() dto: IssueScimTokenDto) {
    const token = 'scim_' + randomBytes(24).toString('base64url');
    const created = (await this.crud.create({ name: dto.name, tokenHash: sha256(token) })) as ScimTokenRow;
    // Plaintext token is surfaced here and never again.
    return { scimToken: sanitize(created), token };
  }

  @Roles('admin') @Post(':id/revoke')
  async revoke(@Param('id') id: string) {
    await this.crud.get(id); // 404s cross-tenant under RLS
    const after = (await this.crud.update(id, { revokedAt: new Date() })) as ScimTokenRow;
    return sanitize(after);
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Never return the token hash (defense in depth — it's a hash, not the secret).
function sanitize(row: ScimTokenRow): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  delete copy.tokenHash;
  return copy;
}

import { Controller, Get, Query } from '@nestjs/common';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { AuditService } from './audit.service';

class ListAuditQuery {
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() offset?: string;
  /** Optional action filter: create|update|delete|login|logout|import|… */
  @IsOptional() @IsString() action?: string;
  /** Inclusive start date (YYYY-MM-DD). */
  @IsOptional() @IsDateString() from?: string;
  /** Inclusive end date (YYYY-MM-DD). */
  @IsOptional() @IsDateString() to?: string;
}

/** Audit list allows larger pages than generic CRUD (Settings history). */
function parseAuditPagination(limit?: string, offset?: string): { limit: number; offset: number } {
  const l = Number.parseInt(limit ?? '', 10);
  const o = Number.parseInt(offset ?? '', 10);
  return {
    limit: Math.min(Math.max(Number.isFinite(l) ? l : 50, 1), 500),
    offset: Math.max(Number.isFinite(o) ? o : 0, 0),
  };
}

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Admin-only: recent administrative + auth events for the tenant. */
  @Roles('admin')
  @Get()
  list(@Query() query: ListAuditQuery) {
    const page = parseAuditPagination(query.limit, query.offset);
    const action = query.action?.trim() || undefined;
    const from = query.from?.trim() || undefined;
    const to = query.to?.trim() || undefined;
    return this.audit.list({ ...page, action, from, to });
  }
}

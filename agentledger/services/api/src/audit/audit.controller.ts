import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { parsePagination } from '../common/pagination';
import { AuditService } from './audit.service';

class ListAuditQuery {
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() offset?: string;
  /** Optional action filter: create|update|delete|login|logout|import|… */
  @IsOptional() @IsString() action?: string;
}

@Controller('v1/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Admin-only: recent administrative + auth events for the tenant. */
  @Roles('admin')
  @Get()
  list(@Query() query: ListAuditQuery) {
    const page = parsePagination(query.limit, query.offset);
    const action = query.action?.trim() || undefined;
    return this.audit.list({ ...page, action });
  }
}

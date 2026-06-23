import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { ImportEventsDto } from './import.dto';
import { ImportService } from './import.service';

/**
 * Bulk import of historical / offline events (admin-only data write).
 *
 * Rows that carry an `idempotency_key` are de-duplicated against prior imports,
 * so re-sending the same batch is safe (no double counting). Tenant isolation is
 * enforced server-side from the principal; request input never sets tenant_id.
 */
@Controller('v1/import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Roles('admin')
  @Post('events')
  importEvents(@Body() dto: ImportEventsDto) {
    return this.importService.importEvents(dto);
  }
}

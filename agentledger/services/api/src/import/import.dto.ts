import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional } from 'class-validator';

/**
 * Bulk-import request for POST /v1/import/events.
 *
 * `events` is an array of flat import rows — free-form objects whose supported
 * fields are documented in import.mapper.ts (usage, outcome, tool call, and/or
 * risk signal per row). The rows are intentionally NOT class-validated here: the
 * mapper validates each field and reports the offending line, which gives far
 * better errors than a generic whitelist rejection. The global ValidationPipe
 * (whitelist + forbidNonWhitelisted) still strips/rejects unknown TOP-LEVEL props
 * but leaves the untyped array elements untouched.
 *
 * The batch is capped to keep it within the API body limit and to bound the
 * import transaction's duration — larger imports are chunked by the caller, and
 * idempotency keys make chunked retries safe.
 */
export class ImportEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  events!: Record<string, unknown>[];

  /** When true, validate + report what WOULD be imported without writing. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

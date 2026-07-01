import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

export class ExecutiveReportQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;

  /** Must match JWT tenant when provided; never overrides auth context. */
  @IsOptional() @IsUUID() tenant_id?: string;

  @IsOptional() @IsIn(['pdf', 'xlsx']) format?: 'pdf' | 'xlsx';
}

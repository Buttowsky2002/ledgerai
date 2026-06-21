import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class RangeQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class AllocationQueryDto extends RangeQueryDto {
  @IsIn(['team', 'app', 'agent']) dimension!: 'team' | 'app' | 'agent';
}

export class BurndownQueryDto extends RangeQueryDto {
  @IsOptional() @IsString() virtualKeyId?: string;
}

export class UnitEconomicsQueryDto extends RangeQueryDto {
  @IsOptional() @IsString() outcomeType?: string;
  // Exclude outcomes whose attribution_confidence is below this (0..1) from the
  // headline aggregates. Filtered server-side before aggregation (Phase 4 task 5).
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) minConfidence?: number;
}

export class RoiQueryDto extends RangeQueryDto {
  @IsOptional() @IsString() outcomeType?: string;
  // Headline ROI excludes links below this confidence; defaults to 0.5 in the
  // service when omitted.
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) minConfidence?: number;
}

export class FocusExportQueryDto extends RangeQueryDto {
  // Response format: 'csv' (default — a FOCUS 1.2 download) or 'json'.
  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
}

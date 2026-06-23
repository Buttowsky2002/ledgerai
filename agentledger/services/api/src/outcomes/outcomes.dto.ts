import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * POST /v1/outcomes body. Field names use the graph's domain vocabulary
 * (value_usd / confidence / source / occurred_at); the service maps them to the
 * canonical ClickHouse outcomes columns. The global ValidationPipe is configured
 * with whitelist + forbidNonWhitelisted, so unknown fields are rejected (rule 5).
 * Per rule 2 there is deliberately NO content field.
 */
export class CreateOutcomeDto {
  @IsString() outcomeType!: string;

  /** Business value of the outcome in USD (>= 0). */
  @IsNumber() @Min(0) valueUsd!: number;

  /** The agent run that produced this outcome (the cost side of the chain). */
  @IsOptional() @IsString() runId?: string;

  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() teamId?: string;

  /** Business source system; defaults to 'api' for manual/API-created outcomes. */
  @IsOptional() @IsString() source?: string;

  /** Attribution confidence in [0,1]; defaults to 1.0 (operator-asserted). */
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;

  /** ISO timestamp the outcome occurred; defaults to now. */
  @IsOptional() @IsDateString() occurredAt?: string;

  @IsOptional() @IsIn(['completed', 'partial', 'failed']) completionStatus?: string;

  /** Optional quality score in [0,1]. */
  @IsOptional() @IsNumber() @Min(0) @Max(1) qualityScore?: number;
}

/** Query filters for GET /v1/outcomes. */
export class ListOutcomesQueryDto {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() outcomeType?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) minConfidence?: number;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() offset?: string;
}

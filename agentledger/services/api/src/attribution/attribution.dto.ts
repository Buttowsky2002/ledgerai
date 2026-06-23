import { Transform } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/** Query for the confidence-audit edge list (sub-phase 3.7). */
export class EdgesQueryDto {
  @IsOptional() @IsString()
  outcomeId?: string;

  @IsOptional() @IsString()
  agentId?: string;

  // Headline aggregates exclude low-confidence edges; the audit UI passes 0 to see
  // everything (below-threshold rows are shown but marked excluded).
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidence?: number;
}

/** Query for the per-subject counterfactual baselines (caveats). */
export class BaselinesQueryDto {
  @IsOptional() @IsIn(['identity', 'team'])
  scope?: 'identity' | 'team';

  @IsOptional() @IsString()
  subjectId?: string;

  @IsOptional() @IsString()
  outcomeType?: string;
}

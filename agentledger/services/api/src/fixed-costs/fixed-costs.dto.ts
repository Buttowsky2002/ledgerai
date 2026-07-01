import {
  Type,
} from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

export const FIXED_COST_VENDORS = ['openai', 'anthropic', 'other'] as const;
export const FIXED_COST_TYPES = [
  'seat_license',
  'subscription',
  'platform_fee',
  'committed_use',
] as const;

/** YYYY-MM-01 */
const MONTH_START = /^\d{4}-\d{2}-01$/;

export class CreateFixedCostDto {
  @IsDateString()
  @Matches(MONTH_START, { message: 'periodMonth must be the first day of a month (YYYY-MM-01)' })
  periodMonth!: string;

  @IsIn(FIXED_COST_VENDORS)
  vendor!: (typeof FIXED_COST_VENDORS)[number];

  @IsIn(FIXED_COST_TYPES)
  costType!: (typeof FIXED_COST_TYPES)[number];

  @IsNumber()
  @Min(0)
  costUsd!: number;

  @IsOptional()
  @IsString()
  lineItem?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seats?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCostUsd?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateFixedCostDto {
  @IsDateString()
  @Matches(MONTH_START, { message: 'periodMonth must be the first day of a month (YYYY-MM-01)' })
  periodMonth!: string;

  @IsIn(FIXED_COST_VENDORS)
  vendor!: (typeof FIXED_COST_VENDORS)[number];

  @IsIn(FIXED_COST_TYPES)
  costType!: (typeof FIXED_COST_TYPES)[number];

  @IsOptional()
  @IsString()
  lineItem?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costUsd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seats?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCostUsd?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class DeleteFixedCostDto {
  @IsDateString()
  @Matches(MONTH_START)
  periodMonth!: string;

  @IsIn(FIXED_COST_VENDORS)
  vendor!: (typeof FIXED_COST_VENDORS)[number];

  @IsIn(FIXED_COST_TYPES)
  costType!: (typeof FIXED_COST_TYPES)[number];

  @IsOptional()
  @IsString()
  lineItem?: string;
}

export class ListFixedCostsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

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
}

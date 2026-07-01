import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PresentationDto {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

export class DesignPartnerAgentDto {
  @IsString() name!: string;
  @IsOptional() @IsString() runtimeType?: string;
  @IsOptional() @IsString() riskPosture?: string;
  @IsOptional() @IsString() approvalStatus?: string;
}

export class DesignPartnerRunDto {
  @IsString() runId!: string;
  @IsString() agentId!: string;
  @IsOptional() @IsString() appId?: string;
  @IsOptional() @IsString() userId?: string;
  @IsString() startedAt!: string;
  @IsString() endedAt!: string;
  @IsString() status!: string;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @IsString() outcomeId?: string;
  @IsNumber() totalCostUsd!: number;
  @IsNumber() totalTokens!: number;
  @IsNumber() llmCalls!: number;
  @IsNumber() toolCalls!: number;
  @IsNumber() riskEvents!: number;
}

export class DesignPartnerOutcomeDto {
  @IsString() outcomeId!: string;
  @IsString() ts!: string;
  @IsString() sourceSystem!: string;
  @IsString() outcomeType!: string;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() userId?: string;
  @IsNumber() businessValueUsd!: number;
  @IsOptional() @IsNumber() qualityScore?: number;
  @IsString() completionStatus!: string;
}

export class DesignPartnerRoiRateDto {
  @IsString() sourceSystem!: string;
  @IsString() outcomeType!: string;
  @IsOptional() @IsNumber() hourlyRate?: number;
  @IsOptional() @IsNumber() baselineMinutes?: number;
  @IsOptional() @IsNumber() reworkPct?: number;
  @IsOptional() @IsNumber() redeploymentFactor?: number;
  @IsOptional() @IsNumber() qaCostPerOutcome?: number;
  @IsOptional() @IsNumber() evalCostPerOutcome?: number;
  @IsOptional() @IsNumber() integrationCostPerOutcome?: number;
  @IsOptional() @IsNumber() platformOverheadPct?: number;
}

/** POST /v1/design-partner/onboard — preset or inline profile. */
export class OnboardDesignPartnerDto {
  @IsOptional() @IsString() preset?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PresentationDto)
  presentation?: PresentationDto;

  @IsOptional() @IsBoolean() clearPrior?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DesignPartnerAgentDto)
  agents?: DesignPartnerAgentDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DesignPartnerRunDto)
  runs?: DesignPartnerRunDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DesignPartnerOutcomeDto)
  outcomes?: DesignPartnerOutcomeDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DesignPartnerRoiRateDto)
  roiRates?: DesignPartnerRoiRateDto[];
}

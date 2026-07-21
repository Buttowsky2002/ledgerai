import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Roles } from '../auth/decorators';
import { LariCfoViewService } from './lari-cfo-view.service';
import { LariRecommendationsService } from './lari-recommendations.service';

class CfoViewQueryDto {
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1) confidenceThreshold?: number;
  @IsOptional() @IsString() team?: string;
  @IsOptional() @IsIn(['computed', 'metered', 'reconciled']) costBasis?: 'computed' | 'metered' | 'reconciled';
  @IsOptional() @Type(() => Number) @IsNumber() @IsIn([7, 30, 90, 180, 365]) forecastDays?: number;
}

class RecommendationsQueryDto {
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}

/** LARI CFO endpoints — tenant-level aggregates built on v_roi (no duplicate engine). */
@Controller('v1/lari')
export class LariController {
  constructor(
    private readonly cfoView: LariCfoViewService,
    private readonly recommendations: LariRecommendationsService,
  ) {}

  @Roles('viewer')
  @Get('cfo-view')
  getCfoView(@Query() q: CfoViewQueryDto) {
    return this.cfoView.getCfoView(
      q.startDate,
      q.endDate,
      q.confidenceThreshold,
      q.team,
      q.costBasis,
      q.forecastDays,
    );
  }

  /** Actionable savings + configuration recommendations from connected data sources. */
  @Roles('viewer')
  @Get('recommendations')
  getRecommendations(@Query() q: RecommendationsQueryDto) {
    return this.recommendations.getRecommendations(q.startDate, q.endDate);
  }
}

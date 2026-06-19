import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import {
  AllocationQueryDto,
  BurndownQueryDto,
  RangeQueryDto,
  RoiQueryDto,
  UnitEconomicsQueryDto,
} from './analytics.dto';
import { AnalyticsService } from './analytics.service';

/**
 * Dashboard analytics — read-only, viewer+, tenant-scoped by injected param.
 * All endpoints query ClickHouse MVs only (never raw llm_calls).
 */
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Roles('viewer') @Get('spend')
  spend(@Query() q: RangeQueryDto) {
    return this.analytics.spend(q.from, q.to);
  }

  @Roles('viewer') @Get('allocation')
  allocation(@Query() q: AllocationQueryDto) {
    return this.analytics.allocation(q.dimension, q.from, q.to);
  }

  @Roles('viewer') @Get('model-mix')
  modelMix(@Query() q: RangeQueryDto) {
    return this.analytics.modelMix(q.from, q.to);
  }

  @Roles('viewer') @Get('burndown')
  burndown(@Query() q: BurndownQueryDto) {
    return this.analytics.burndown(q.from, q.to, q.virtualKeyId);
  }

  @Roles('viewer') @Get('risk')
  risk(@Query() q: RangeQueryDto) {
    return this.analytics.risk(q.from, q.to);
  }

  @Roles('viewer') @Get('unit-economics')
  unitEconomics(@Query() q: UnitEconomicsQueryDto) {
    return this.analytics.unitEconomics(q.from, q.to, q.outcomeType, q.minConfidence);
  }

  @Roles('viewer') @Get('roi')
  roi(@Query() q: RoiQueryDto) {
    return this.analytics.roi(q.from, q.to, q.outcomeType, q.minConfidence);
  }

  @Roles('viewer') @Get('agents/:agentId')
  agentDetail(@Param('agentId') agentId: string, @Query() q: RangeQueryDto) {
    return this.analytics.agentDetail(agentId, q.from, q.to);
  }
}

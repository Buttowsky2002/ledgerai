import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { BaselinesQueryDto, EdgesQueryDto } from './attribution.dto';
import { AttributionService } from './attribution.service';

/**
 * Confidence-audit API (sub-phase 3.7) — read-only, viewer+, tenant-scoped by RLS.
 * Lets a reviewer trace any attributed score to its source evidence: the signal
 * breakdown, method, model version, counterfactual delta, and Shapley split.
 */
@Controller('v1/attribution')
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  /** Attribution edges for an outcome or agent (the per-signal breakdown lives on each edge). */
  @Roles('viewer') @Get('edges')
  edges(@Query() q: EdgesQueryDto) {
    return this.attribution.edges(q.outcomeId, q.agentId, q.minConfidence ?? 0);
  }

  /** A multi-agent coalition's Shapley split. */
  @Roles('viewer') @Get('coalitions/:coalitionId')
  coalition(@Param('coalitionId') coalitionId: string) {
    return this.attribution.coalition(coalitionId);
  }

  /** Counterfactual baselines + confounder-check caveats behind the incremental value. */
  @Roles('viewer') @Get('baselines')
  baselines(@Query() q: BaselinesQueryDto) {
    return this.attribution.baselines(q.scope, q.subjectId, q.outcomeType);
  }
}

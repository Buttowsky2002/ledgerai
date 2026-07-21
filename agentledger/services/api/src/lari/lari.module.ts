import { Module } from '@nestjs/common';
import { UserValueModule } from '../analytics/user-value.module';
import { CursorAnalyticsService } from '../connectors/cursor-analytics.service';
import { CursorProductivityService } from '../connectors/cursor-productivity.service';
import { GitHubCopilotModule } from '../github-copilot/github-copilot.module';
import { LariCfoViewService } from './lari-cfo-view.service';
import { LariController } from './lari.controller';
import { LariRecommendationsService } from './lari-recommendations.service';
import { LariService } from './lari.service';

/** Exposes the LARI engine so both AgentsModule (per-agent endpoint) and
 *  AnalyticsModule (the agent-economics rollup) can reuse one service. */
@Module({
  imports: [GitHubCopilotModule, UserValueModule],
  controllers: [LariController],
  providers: [
    LariService,
    LariCfoViewService,
    LariRecommendationsService,
    CursorAnalyticsService,
    CursorProductivityService,
  ],
  exports: [LariService, LariCfoViewService, LariRecommendationsService],
})
export class LariModule {}

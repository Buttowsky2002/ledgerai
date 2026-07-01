import { Module } from '@nestjs/common';
import { GitHubCopilotModule } from '../github-copilot/github-copilot.module';
import { LariCfoViewService } from './lari-cfo-view.service';
import { LariController } from './lari.controller';
import { LariRecommendationsService } from './lari-recommendations.service';
import { LariService } from './lari.service';

/** Exposes the LARI engine so both AgentsModule (per-agent endpoint) and
 *  AnalyticsModule (the agent-economics rollup) can reuse one service. */
@Module({
  imports: [GitHubCopilotModule],
  controllers: [LariController],
  providers: [LariService, LariCfoViewService, LariRecommendationsService],
  exports: [LariService, LariCfoViewService, LariRecommendationsService],
})
export class LariModule {}

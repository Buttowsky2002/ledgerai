import { Module } from '@nestjs/common';
import { GitHubCopilotModule } from '../github-copilot/github-copilot.module';
import { LariModule } from '../lari/lari.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [LariModule, GitHubCopilotModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}

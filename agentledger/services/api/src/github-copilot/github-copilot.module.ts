import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { CopilotAnalyticsService } from './github-copilot-analytics.service';
import { CopilotMemberSpendService } from './github-copilot-member-spend.service';
import { GitHubCopilotController } from './github-copilot.controller';
import { GitHubCopilotSchedulerService } from './github-copilot-scheduler.service';
import { GitHubCopilotService } from './github-copilot.service';
import { GitHubCopilotSyncService } from './github-copilot-sync.service';

@Module({
  imports: [ConnectorsModule],
  controllers: [GitHubCopilotController],
  providers: [
    GitHubCopilotService,
    GitHubCopilotSyncService,
    CopilotAnalyticsService,
    CopilotMemberSpendService,
    GitHubCopilotSchedulerService,
  ],
  exports: [
    GitHubCopilotService,
    GitHubCopilotSyncService,
    CopilotAnalyticsService,
    CopilotMemberSpendService,
  ],
})
export class GitHubCopilotModule {}

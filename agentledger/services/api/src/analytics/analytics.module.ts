import { Module } from '@nestjs/common';
import { ClickHouseModule } from '../clickhouse/clickhouse.module';
import { GitHubCopilotModule } from '../github-copilot/github-copilot.module';
import { LariModule } from '../lari/lari.module';
import { CursorAnalyticsService } from '../connectors/cursor-analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { UserValueModule } from './user-value.module';

@Module({
  imports: [LariModule, GitHubCopilotModule, ClickHouseModule, UserValueModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, CursorAnalyticsService],
})
export class AnalyticsModule {}

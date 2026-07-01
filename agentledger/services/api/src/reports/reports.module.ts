import { Module } from '@nestjs/common';
import { ClickHouseModule } from '../clickhouse/clickhouse.module';
import { GitHubCopilotModule } from '../github-copilot/github-copilot.module';
import { PrismaModule } from '../prisma/prisma.module';import { ExecutiveReportService } from './executive-report.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [ClickHouseModule, PrismaModule, GitHubCopilotModule],  controllers: [ReportsController],
  providers: [ExecutiveReportService],
})
export class ReportsModule {}

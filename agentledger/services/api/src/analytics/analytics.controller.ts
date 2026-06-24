import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../auth/decorators';
import {
  AllocationQueryDto,
  BurndownQueryDto,
  FocusExportQueryDto,
  PilotReportQueryDto,
  RangeQueryDto,
  RoiQueryDto,
  UnitEconomicsQueryDto,
} from './analytics.dto';
import { AnalyticsService } from './analytics.service';
import { toCsv } from './focus.mapper';
import { renderMarkdown } from './report.renderer';

/**
 * Dashboard analytics — read-only, viewer+, tenant-scoped by injected param.
 * All endpoints query ClickHouse MVs only (never raw llm_calls).
 */
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Roles('viewer') @Get('spend')
  spend(@Query() q: RangeQueryDto) {
    return this.analytics.spend(q.from, q.to, q.team);
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
    return this.analytics.risk(q.from, q.to, q.team);
  }

  @Roles('viewer') @Get('unit-economics')
  unitEconomics(@Query() q: UnitEconomicsQueryDto) {
    return this.analytics.unitEconomics(q.from, q.to, q.outcomeType, q.minConfidence, q.team);
  }

  @Roles('viewer') @Get('roi')
  roi(@Query() q: RoiQueryDto) {
    return this.analytics.roi(q.from, q.to, q.outcomeType, q.minConfidence, q.team);
  }

  // Per-agent economics + LARI recommendation (overview recommendations + table).
  @Roles('viewer') @Get('agent-economics')
  agentEconomics(@Query() q: RangeQueryDto) {
    return this.analytics.agentEconomics(q.from, q.to);
  }

  @Roles('viewer') @Get('agent-risk')
  agentRisk() {
    return this.analytics.agentRisk();
  }

  /** FOCUS 1.2 cost export (ADR-035). Default CSV download; ?format=json for rows. */
  @Roles('viewer') @Get('focus-export')
  async focusExport(@Query() q: FocusExportQueryDto, @Res() res: Response): Promise<void> {
    const rows = await this.analytics.focusExport(q.from, q.to);
    if (q.format === 'json') {
      res.json(rows);
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="focus-1.2-export.csv"');
    res.send(toCsv(rows));
  }

  /** 30-day pilot report (ADR-036). JSON by default; ?format=md renders Markdown. */
  @Roles('viewer') @Get('pilot-report')
  async pilotReport(@Query() q: PilotReportQueryDto, @Res() res: Response): Promise<void> {
    const report = await this.analytics.pilotReport(q.from, q.to);
    if (q.format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(renderMarkdown(report));
      return;
    }
    res.json(report);
  }

  @Roles('viewer') @Get('agents/:agentId')
  agentDetail(@Param('agentId') agentId: string, @Query() q: RangeQueryDto) {
    return this.analytics.agentDetail(agentId, q.from, q.to);
  }
}

import { BadRequestException, Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../auth/decorators';
import { getTenantId } from '../tenant/tenant-context';
import { ExecutiveReportService } from './executive-report.service';
import { ExecutiveReportQueryDto } from './reports.dto';
import { generateExecutivePdf } from './export/pdf-generator';
import { generateExecutiveXlsx } from './export/xlsx-generator';

@Controller('v1/reports')
export class ReportsController {
  private readonly log = new Logger(ReportsController.name);

  constructor(private readonly reports: ExecutiveReportService) {}

  /** One-click executive report export (PDF or XLSX). */
  @Roles('viewer')
  @Get('executive')
  async executive(@Query() q: ExecutiveReportQueryDto, @Res() res: Response): Promise<void> {
    const format = q.format ?? 'pdf';
    try {
      const data = await this.reports.build(q.from, q.to, q.tenant_id);
      const tenantId = getTenantId();
      if (tenantId) {
        await this.reports.auditExport(tenantId, data.window.from, data.window.to, format);
      }

      if (format === 'xlsx') {
        const buf = await generateExecutiveXlsx(data);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="executive-report-${data.window.from}-${data.window.to}.xlsx"`,
        );
        res.send(buf);
        return;
      }

      if (format !== 'pdf') {
        throw new BadRequestException('format must be pdf or xlsx');
      }

      const buf = await generateExecutivePdf(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="executive-report-${data.window.from}-${data.window.to}.pdf"`,
      );
      res.send(buf);
    } catch (err) {
      this.log.error(`executive export failed format=${format} from=${q.from} to=${q.to}`, err instanceof Error ? err.stack : err);
      throw err;
    }
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { ImportService } from '../import/import.service';

import { PrismaService } from '../prisma/prisma.service';

import { getPrincipal, getTenantId } from '../tenant/tenant-context';

import {

  parseAnthropicPortalCsv,

  suggestedApiSyncBaseline,

  PORTAL_IMPORT_SOURCE,

} from './anthropic-portal.parser';

import type { ColumnMappingByName } from './column-mapping';



export interface PortalFileResult {

  fileName: string;

  parsed: number;

  skipped: number;

  skippedZeroCost: number;

  imported: number;

  duplicateSkipped: number;

  usersDetected: number;

  totalCostUsd: number;

  dateRange: { from: string | null; to: string | null };

  parseErrors: { line: number; message: string }[];

  preview: Record<string, unknown>[];

  headers: string[];

  mappingUsed: ColumnMappingByName | null;

  ok: boolean;

  error?: string;

}



export interface PortalUploadResult {

  source: typeof PORTAL_IMPORT_SOURCE;

  provider: 'anthropic';

  dryRun: boolean;

  files: PortalFileResult[];

  parsed: number;

  skipped: number;

  imported: number;

  duplicateSkipped: number;

  usersDetected: number;

  totalCostUsd: number;

  dateRange: { from: string | null; to: string | null };

  suggestedApiSyncBaseline: string | null;

  portalImportThrough: string | null;

}



export interface PortalPreviewResult {
  fileName?: string;
  headers: string[];
  headerRow: number;
  delimiter: string;
  format: ReturnType<typeof parseAnthropicPortalCsv>['format'];
  suggestion: ReturnType<typeof parseAnthropicPortalCsv>['suggestion'];
  mapping: ColumnMappingByName | null;
  importable: boolean;

  parsed: number;

  skipped: number;

  skippedZeroCost: number;

  usersDetected: number;

  totalCostUsd: number;

  dateRange: { from: string | null; to: string | null };

  parseErrors: { line: number; message: string }[];

  preview: Record<string, unknown>[];

  sampleRawRows: string[][];

}



@Injectable()

export class PortalImportService {

  private readonly logger = new Logger(PortalImportService.name);



  constructor(

    private readonly prisma: PrismaService,

    private readonly importService: ImportService,

  ) {}



  previewAnthropicCsv(

    csvText: string,

    opts?: { fileName?: string; mapping?: ColumnMappingByName },

  ): PortalPreviewResult {

    if (!csvText?.trim()) throw new BadRequestException('csv body is empty');

    const parsed = parseAnthropicPortalCsv(csvText, opts?.mapping, opts?.fileName);

    const sampleRawRows: string[][] = [];

    // Re-parse for raw samples (lightweight — preview only)

    const lines = csvText.trim().split(/\r?\n/).slice(parsed.headerRow, parsed.headerRow + 6);

    for (let i = 1; i < lines.length && sampleRawRows.length < 5; i++) {

      sampleRawRows.push(lines[i]?.split(parsed.delimiter === '\t' ? '\t' : parsed.delimiter) ?? []);

    }



    return {
      fileName: opts?.fileName,
      headers: parsed.headers,
      headerRow: parsed.headerRow,
      delimiter: parsed.delimiter,
      format: parsed.format,
      suggestion: parsed.suggestion,

      mapping: parsed.mappingUsed,

      importable: parsed.rows.length > 0,

      parsed: parsed.stats.parsed,

      skipped: parsed.stats.skipped,

      skippedZeroCost: parsed.stats.skippedZeroCost,

      usersDetected: parsed.stats.usersDetected,

      totalCostUsd: parsed.stats.totalCostUsd,

      dateRange: { from: parsed.stats.minDay, to: parsed.stats.maxDay },

      parseErrors: parsed.errors,

      preview: parsed.preview,

      sampleRawRows,

    };

  }



  async uploadAnthropicCsv(

    csvText: string,

    opts?: { connectorId?: string; dryRun?: boolean; mapping?: ColumnMappingByName; fileName?: string },

  ): Promise<PortalUploadResult> {

    return this.uploadAnthropicBatch([{ name: opts?.fileName ?? 'upload.csv', csv: csvText, mapping: opts?.mapping }], opts);

  }



  async uploadAnthropicBatch(

    files: { name: string; csv: string; mapping?: ColumnMappingByName }[],

    opts?: { connectorId?: string; dryRun?: boolean },

  ): Promise<PortalUploadResult> {

    const tenantId = getTenantId();

    if (!tenantId) throw new BadRequestException('no tenant in context');

    if (!files.length) throw new BadRequestException('no files provided');



    const dryRun = opts?.dryRun === true;

    const fileResults: PortalFileResult[] = [];

    let allRows: Record<string, unknown>[] = [];

    let globalMin: string | null = null;

    let globalMax: string | null = null;

    const allUsers = new Set<string>();



    for (const file of files) {

      if (!file.csv?.trim()) {

        fileResults.push({

          fileName: file.name,

          parsed: 0,

          skipped: 0,

          skippedZeroCost: 0,

          imported: 0,

          duplicateSkipped: 0,

          usersDetected: 0,

          totalCostUsd: 0,

          dateRange: { from: null, to: null },

          parseErrors: [{ line: 1, message: 'file is empty' }],

          preview: [],

          headers: [],

          mappingUsed: null,

          ok: false,

          error: 'file is empty',

        });

        continue;

      }



      const parsed = parseAnthropicPortalCsv(file.csv, file.mapping, file.name);

      if (parsed.rows.length === 0) {

        const hint =

          parsed.stats.skippedZeroCost > 0 && parsed.stats.dataRows > 0

            ? 'all data rows have zero or missing cost — check cost column mapping or cost unit (USD vs cents)'

            : parsed.errors[0]?.message ?? 'no importable rows';

        fileResults.push({

          fileName: file.name,

          parsed: 0,

          skipped: parsed.stats.skipped,

          skippedZeroCost: parsed.stats.skippedZeroCost,

          imported: 0,

          duplicateSkipped: 0,

          usersDetected: 0,

          totalCostUsd: 0,

          dateRange: { from: parsed.stats.minDay, to: parsed.stats.maxDay },

          parseErrors: parsed.errors,

          preview: parsed.preview,

          headers: parsed.headers,

          mappingUsed: parsed.mappingUsed,

          ok: false,

          error: hint,

        });

        continue;

      }



      for (const row of parsed.rows) {

        const uid = String(row.user_id ?? '');

        if (uid && uid !== 'Unassigned') allUsers.add(uid);

      }

      if (parsed.stats.minDay && (!globalMin || parsed.stats.minDay < globalMin)) globalMin = parsed.stats.minDay;

      if (parsed.stats.maxDay && (!globalMax || parsed.stats.maxDay > globalMax)) globalMax = parsed.stats.maxDay;

      allRows = allRows.concat(parsed.rows);



      fileResults.push({

        fileName: file.name,

        parsed: parsed.stats.parsed,

        skipped: parsed.stats.skipped,

        skippedZeroCost: parsed.stats.skippedZeroCost,

        imported: 0,

        duplicateSkipped: 0,

        usersDetected: parsed.stats.usersDetected,

        totalCostUsd: parsed.stats.totalCostUsd,

        dateRange: { from: parsed.stats.minDay, to: parsed.stats.maxDay },

        parseErrors: parsed.errors,

        preview: parsed.preview,

        headers: parsed.headers,

        mappingUsed: parsed.mappingUsed,

        ok: true,

      });

    }



    const importableFiles = fileResults.filter((f) => f.ok);

    if (importableFiles.length === 0) {

      throw new BadRequestException({

        message: 'no importable rows found in any CSV',

        files: fileResults.map((f) => ({ fileName: f.fileName, error: f.error, parseErrors: f.parseErrors })),

      });

    }



    let imported = 0;

    let duplicateSkipped = 0;

    const totalParsed = importableFiles.reduce((s, f) => s + f.parsed, 0);

    const totalSkipped = fileResults.reduce((s, f) => s + f.skipped, 0);

    const totalCostUsd = importableFiles.reduce((s, f) => s + f.totalCostUsd, 0);



    if (!dryRun) {

      for (let i = 0; i < allRows.length; i += 1000) {

        const batch = allRows.slice(i, i + 1000);

        const summary = await this.importService.importEvents({ events: batch, dryRun: false });

        imported += summary.imported;

        duplicateSkipped += summary.skipped;

      }



      if (opts?.connectorId) {

        await this.updateConnectorHandoff(tenantId, opts.connectorId, globalMax);

      }



      await this.prisma.withTenant(tenantId, (tx) =>

        tx.auditLog.create({

          data: {

            tenantId,

            actor: getPrincipal()?.userId ?? 'system',

            action: 'import',

            object: 'portal-import:anthropic',

            detail: {

              source: PORTAL_IMPORT_SOURCE,

              fileCount: files.length,

              filesImported: importableFiles.length,

              parsed: totalParsed,

              imported,

              duplicateSkipped,

              from: globalMin,

              to: globalMax,

              usersDetected: allUsers.size,

              totalCostUsd,

            },

          },

        }),

      );



      this.logger.log(

        {

          event: 'portal_import',

          tenantId,

          fileCount: files.length,

          imported,

          duplicateSkipped,

          from: globalMin,

          to: globalMax,

        },

        'anthropic portal CSV batch imported',

      );

    }



    for (const fr of fileResults) {

      if (fr.ok && !dryRun) {

        fr.imported = fr.parsed;

      }

    }



    return {

      source: PORTAL_IMPORT_SOURCE,

      provider: 'anthropic',

      dryRun,

      files: fileResults,

      parsed: totalParsed,

      skipped: totalSkipped,

      imported,

      duplicateSkipped,

      usersDetected: allUsers.size,

      totalCostUsd,

      dateRange: { from: globalMin, to: globalMax },

      suggestedApiSyncBaseline: suggestedApiSyncBaseline(globalMax),

      portalImportThrough: globalMax,

    };

  }



  private async updateConnectorHandoff(

    tenantId: string,

    connectorId: string,

    portalImportThrough: string | null,

  ): Promise<void> {

    if (!portalImportThrough) return;



    await this.prisma.withTenant(tenantId, async (tx) => {

      const row = await tx.connector.findUnique({ where: { connectorId } });

      if (!row) throw new NotFoundException('connector not found');



      const cfg = (row.config ?? {}) as Record<string, unknown>;

      const baseline = suggestedApiSyncBaseline(portalImportThrough);

      const next: Record<string, unknown> = {

        ...cfg,

        portalImportThrough,

      };

      if (baseline && !cfg.apiSyncBaselineFrom) {

        next.apiSyncBaselineFrom = baseline;

      }



      await tx.connector.update({

        where: { connectorId },

        data: { config: next as Prisma.InputJsonValue },

      });

    });

  }

}



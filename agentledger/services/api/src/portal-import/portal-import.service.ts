import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { randomUUID } from 'node:crypto';

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

  provider: string;

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

  importRunId: string | null;

}



export interface PortalImportRunItem {
  id: string;
  legacy: boolean;
  createdAt: string;
  actor: string;
  provider: string;
  providers: string[];
  fileNames: string[];
  dateRange: { from: string | null; to: string | null };
  rowsImported: number;
  rowsSkipped: number;
  totalCostUsd: number;
  deletable: boolean;
}



export interface PortalImportRunDeleteResult {
  id: string;
  legacy: boolean;
  rowsDeleted: number;
  keysReleased: number;
}



export interface PortalPreviewResult {
  fileName?: string;
  headers: string[];
  headerRow: number;
  delimiter: string;
  format: ReturnType<typeof parseAnthropicPortalCsv>['format'];
  suggestion: ReturnType<typeof parseAnthropicPortalCsv>['suggestion'];
  mapping: ColumnMappingByName | null;
  provider: string | null;
  requiresProvider: boolean;
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

    opts?: { fileName?: string; mapping?: ColumnMappingByName; provider?: string },

  ): PortalPreviewResult {

    if (!csvText?.trim()) throw new BadRequestException('csv body is empty');

    const parsed = parseAnthropicPortalCsv(csvText, opts?.mapping, opts?.fileName, opts?.provider);

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
      provider: parsed.provider,
      requiresProvider: parsed.requiresProvider,

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

    opts?: { connectorId?: string; dryRun?: boolean; mapping?: ColumnMappingByName; fileName?: string; provider?: string },

  ): Promise<PortalUploadResult> {

    return this.uploadAnthropicBatch(
      [{ name: opts?.fileName ?? 'upload.csv', csv: csvText, mapping: opts?.mapping, provider: opts?.provider }],
      opts,
    );

  }



  async uploadAnthropicBatch(

    files: { name: string; csv: string; mapping?: ColumnMappingByName; provider?: string }[],

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
    const providersUsed = new Set<string>();
    const purgeByProvider = new Map<string, { min: string; max: string }>();



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



      const parsed = parseAnthropicPortalCsv(file.csv, file.mapping, file.name, file.provider);

      if (parsed.requiresProvider) {
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
          error: 'select a billing provider for this file',
        });
        continue;
      }

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
      if (parsed.provider) {
        providersUsed.add(parsed.provider);
        if (parsed.stats.minDay && parsed.stats.maxDay) {
          const existing = purgeByProvider.get(parsed.provider);
          if (!existing) {
            purgeByProvider.set(parsed.provider, { min: parsed.stats.minDay, max: parsed.stats.maxDay });
          } else {
            if (parsed.stats.minDay < existing.min) existing.min = parsed.stats.minDay;
            if (parsed.stats.maxDay > existing.max) existing.max = parsed.stats.maxDay;
          }
        }
      }
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



    let importRunId: string | null = null;

    if (!dryRun) {
      const runId = randomUUID();
      importRunId = runId;
      for (const row of allRows) {
        row.import_run_id = runId;
      }

      for (const [provider, range] of purgeByProvider) {
        await this.importService.purgePortalImportWindow(provider, range.min, range.max);
      }
      const importKeys = allRows
        .map((row) => String(row.idempotency_key ?? ''))
        .filter((key) => key.length > 0);
      await this.importService.releaseImportKeys(importKeys);

      for (let i = 0; i < allRows.length; i += 1000) {

        const batch = allRows.slice(i, i + 1000);

        const summary = await this.importService.importEvents({ events: batch, dryRun: false });

        imported += summary.imported;

        duplicateSkipped += summary.skipped;

      }



      if (opts?.connectorId && providersUsed.has('anthropic')) {

        await this.updateConnectorHandoff(tenantId, opts.connectorId, globalMax);

      }



      await this.prisma.withTenant(tenantId, (tx) =>
        tx.portalImportRun.create({
          data: {
            importRunId: runId,
            tenantId,
            source: PORTAL_IMPORT_SOURCE,
            provider: providersUsed.size === 1 ? [...providersUsed][0]! : 'mixed',
            providers: [...providersUsed],
            fileNames: importableFiles.map((f) => f.fileName),
            dateFrom: globalMin ? new Date(`${globalMin}T00:00:00.000Z`) : null,
            dateTo: globalMax ? new Date(`${globalMax}T00:00:00.000Z`) : null,
            rowsParsed: totalParsed,
            rowsImported: imported,
            rowsSkipped: duplicateSkipped,
            totalCostUsd,
            actor: getPrincipal()?.userId ?? 'system',
          },
        }),
      );

      await this.prisma.withTenant(tenantId, (tx) =>

        tx.auditLog.create({

          data: {

            tenantId,

            actor: getPrincipal()?.userId ?? 'system',

            action: 'import',

            object: `portal-import:${providersUsed.size === 1 ? [...providersUsed][0] : 'mixed'}`,

            detail: {

              source: PORTAL_IMPORT_SOURCE,

              importRunId: runId,

              providers: [...providersUsed],

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

        'portal billing CSV batch imported',

      );

    }



    for (const fr of fileResults) {

      if (fr.ok && !dryRun) {

        fr.imported = fr.parsed;

      }

    }



    return {

      source: PORTAL_IMPORT_SOURCE,

      provider: providersUsed.size === 1 ? [...providersUsed][0]! : 'mixed',

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

      importRunId,

    };

  }



  async listImportRuns(limit = 50): Promise<{ runs: PortalImportRunItem[] }> {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant in context');
    const cap = Math.min(Math.max(limit, 1), 100);

    const tracked = await this.prisma.withTenant(tenantId, (tx) =>
      tx.portalImportRun.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        take: cap,
      }),
    );
    const trackedIds = new Set(tracked.map((r) => r.importRunId));

    const audits = await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'import', object: { startsWith: 'portal-import:' } },
        orderBy: { at: 'desc' },
        take: cap,
      }),
    );

    const runs: PortalImportRunItem[] = tracked.map((r) => ({
      id: r.importRunId,
      legacy: false,
      createdAt: r.createdAt.toISOString(),
      actor: r.actor,
      provider: r.provider,
      providers: r.providers,
      fileNames: r.fileNames,
      dateRange: {
        from: r.dateFrom ? r.dateFrom.toISOString().slice(0, 10) : null,
        to: r.dateTo ? r.dateTo.toISOString().slice(0, 10) : null,
      },
      rowsImported: r.rowsImported,
      rowsSkipped: r.rowsSkipped,
      totalCostUsd: r.totalCostUsd,
      deletable: true,
    }));

    for (const audit of audits) {
      const detail = (audit.detail ?? {}) as Record<string, unknown>;
      const importRunId = typeof detail.importRunId === 'string' ? detail.importRunId : null;
      if (importRunId && trackedIds.has(importRunId)) continue;

      const providers = Array.isArray(detail.providers)
        ? detail.providers.map((p) => String(p))
        : audit.object.startsWith('portal-import:')
          ? [audit.object.slice('portal-import:'.length)]
          : [];
      const from = typeof detail.from === 'string' ? detail.from.slice(0, 10) : null;
      const to = typeof detail.to === 'string' ? detail.to.slice(0, 10) : null;

      runs.push({
        id: `audit:${audit.id}`,
        legacy: true,
        createdAt: audit.at.toISOString(),
        actor: audit.actor,
        provider: providers.length === 1 ? providers[0]! : 'mixed',
        providers,
        fileNames: [],
        dateRange: { from, to },
        rowsImported: typeof detail.imported === 'number' ? detail.imported : 0,
        rowsSkipped: typeof detail.duplicateSkipped === 'number' ? detail.duplicateSkipped : 0,
        totalCostUsd: typeof detail.totalCostUsd === 'number' ? detail.totalCostUsd : 0,
        deletable: Boolean(from && to && providers.length > 0),
      });
    }

    runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { runs: runs.slice(0, cap) };
  }



  async deleteImportRun(runId: string): Promise<PortalImportRunDeleteResult> {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant in context');
    if (!runId?.trim()) throw new BadRequestException('run id is required');

    if (runId.startsWith('audit:')) {
      const auditId = Number(runId.slice('audit:'.length));
      if (!Number.isFinite(auditId)) throw new BadRequestException('invalid legacy run id');
      const audit = await this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.findFirst({ where: { id: BigInt(auditId) } }),
      );
      if (!audit) throw new NotFoundException('import run not found');
      const detail = (audit.detail ?? {}) as Record<string, unknown>;
      const from = typeof detail.from === 'string' ? detail.from.slice(0, 10) : null;
      const to = typeof detail.to === 'string' ? detail.to.slice(0, 10) : null;
      const providers = Array.isArray(detail.providers)
        ? detail.providers.map((p) => String(p))
        : audit.object.startsWith('portal-import:')
          ? [audit.object.slice('portal-import:'.length)]
          : [];
      if (!from || !to || providers.length === 0) {
        throw new BadRequestException('legacy import run is missing date range or provider metadata');
      }
      for (const provider of providers) {
        if (provider === 'mixed') continue;
        await this.importService.purgePortalImportWindow(provider, from, to);
      }
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            actor: getPrincipal()?.userId ?? 'system',
            action: 'delete',
            object: `portal-import:audit:${auditId}`,
            detail: { from, to, providers, note: 'legacy window purge' },
          },
        }),
      );
      return { id: runId, legacy: true, rowsDeleted: 0, keysReleased: 0 };
    }

    const run = await this.prisma.withTenant(tenantId, (tx) =>
      tx.portalImportRun.findFirst({ where: { importRunId: runId, status: 'active' } }),
    );
    if (!run) throw new NotFoundException('import run not found');

    const { rowsDeleted, keysReleased } = await this.importService.deletePortalImportRun(runId);

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.portalImportRun.update({
        where: { importRunId: runId },
        data: { status: 'deleted', deletedAt: new Date() },
      }),
    );

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId,
          actor: getPrincipal()?.userId ?? 'system',
          action: 'delete',
          object: `portal-import:${runId}`,
          detail: { rowsDeleted, keysReleased, provider: run.provider },
        },
      }),
    );

    this.logger.log(
      { event: 'portal_import_deleted', tenantId, importRunId: runId, rowsDeleted, keysReleased },
      'portal import run deleted',
    );

    return { id: runId, legacy: false, rowsDeleted, keysReleased };
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



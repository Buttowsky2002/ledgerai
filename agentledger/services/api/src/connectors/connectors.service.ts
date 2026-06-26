import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getPrincipal, getTenantId } from '../tenant/tenant-context';
import { recordAudit } from '../common/audit';
import { Page } from '../common/pagination';
import { ImportService } from '../import/import.service';
import { ConnectorDefinitionsService } from './connector-definitions.service';
import { ConnectorSecretsService } from './connector-secrets.service';
import { fetchAllRecords, fetchPreviewPage } from './engine/connector-engine';
import type { ApiCredentials } from './engine/api-client';
import { sanitizeForPreview, safeErrorMessage } from './engine/sanitizer';
import { resolveSyncWindow } from './sync-range';
import { ConnectorDefinition } from './types/connector-definition';
import { toImportRow } from './types/normalized-record';

const NO_COST_ROWS_WARNING =
  'API connected, but Anthropic returned no cost rows for the last 30 days. ' +
  'Confirm this Admin API key belongs to an org with billable Claude usage, or try a longer history in the Anthropic console.';

/** True when cost_report returned day buckets but every results[] array is empty. */
function anthropicCostBucketsEmpty(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.every((bucket) => {
    if (!bucket || typeof bucket !== 'object') return true;
    const results = (bucket as { results?: unknown }).results;
    return !Array.isArray(results) || results.length === 0;
  });
}

export interface CreateConnectorDto {
  connectorDefinitionId?: string;
  presetId?: string;
  displayName: string;
  provider?: string;
  category?: string;
  configJson?: Record<string, unknown>;
  mappingOverridesJson?: Record<string, unknown>;
  scheduleJson?: Record<string, unknown>;
  authSecret?: string;
  authType?: string;
  baseUrl?: string;
  enabled?: boolean;
}

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly definitions: ConnectorDefinitionsService,
    private readonly secrets: ConnectorSecretsService,
    private readonly importService: ImportService,
  ) {}

  private applyCreateOverrides(
    def: ConnectorDefinition,
    dto: CreateConnectorDto,
  ): ConnectorDefinition {
    const cfg = dto.configJson ?? {};
    const authType = (cfg.authType as ConnectorDefinition['authType']) ?? def.authType;
    const isAnthropicBuiltin = def.id === 'anthropic-usage' || dto.presetId === 'anthropic-usage';
    let endpoints = def.endpoints ? [...def.endpoints] : [];
    const endpointPath = cfg.endpointPath as string | undefined;
    if (endpointPath && !isAnthropicBuiltin) {
      if (endpoints.length > 0) {
        endpoints[0] = { ...endpoints[0], path: endpointPath };
      } else {
        endpoints = [{ path: endpointPath, method: 'GET' }];
      }
    }
    return {
      ...def,
      baseUrl: dto.baseUrl ?? def.baseUrl,
      authType,
      authHeaderName:
        authType === 'api_key_header' ? def.authHeaderName ?? 'x-api-key' : def.authHeaderName,
      endpoints,
    };
  }

  private resolveStoredDefinition(
    cfg: Record<string, unknown>,
  ): ConnectorDefinition | undefined {
    if (!cfg?.definition) return undefined;
    const def = { ...(cfg.definition as ConnectorDefinition) };
    if (cfg.baseUrl) def.baseUrl = String(cfg.baseUrl);
    const endpointPath = cfg.endpointPath as string | undefined;
    if (endpointPath && def.endpoints?.[0]) {
      def.endpoints = [{ ...def.endpoints[0], path: endpointPath }];
    }
    return def;
  }

  private mergeBuiltinDefinition(
    kind: string,
    cfg: Record<string, unknown>,
  ): ConnectorDefinition {
    const fresh = this.definitions.getBuiltin(kind);
    const baseUrl = cfg.baseUrl ? String(cfg.baseUrl) : fresh.baseUrl;

    // Built-in Anthropic preset manages its own endpoints (analytics user cost +
    // cost_report fallback). Ignore stale endpointPath saved from older UI defaults.
    if (kind === 'anthropic-usage') {
      return { ...fresh, baseUrl };
    }

    const endpointPath = cfg.endpointPath as string | undefined;
    let endpoints = fresh.endpoints;
    if (endpointPath && endpoints[0]) {
      if (endpointPath.includes('cost_report') && fresh.fallbackDefinition?.endpoints?.[0]) {
        endpoints = [{ ...fresh.fallbackDefinition.endpoints[0], path: endpointPath }];
      } else {
        endpoints = [{ ...endpoints[0], path: endpointPath }];
      }
    }
    return { ...fresh, baseUrl, endpoints };
  }

  private async resolveDefinition(row: {
    connectorDefinitionId: string | null;
    config: unknown;
    kind: string | null;
  }): Promise<ConnectorDefinition> {
    if (row.connectorDefinitionId) {
      return this.definitions.get(row.connectorDefinitionId);
    }
    const cfg = row.config as Record<string, unknown>;
    if (row.kind && this.definitions.listBuiltin().some((p) => p.id === row.kind)) {
      return this.mergeBuiltinDefinition(row.kind, cfg);
    }
    const fromConfig = this.resolveStoredDefinition(cfg);
    if (fromConfig) return fromConfig;
    throw new BadRequestException('connector has no definition');
  }

  private parseCredentials(secret: string | undefined, authType?: string): ApiCredentials {
    if (!secret) return {};
    if (authType === 'basic_auth') {
      const [username, password] = secret.split(':');
      return { username, password };
    }
    if (authType === 'custom_header') {
      const [name, ...rest] = secret.split('=');
      return { customHeader: { name, value: rest.join('=') } };
    }
    if (authType === 'bearer_token') return { bearerToken: secret };
    return { apiKey: secret };
  }

  list(page: Page) {
    return this.prisma.withTenant(getTenantId(), (tx) =>
      tx.connector.findMany({
        take: page.limit,
        skip: page.offset,
        orderBy: { connectorId: 'asc' },
      }),
    );
  }

  async get(id: string) {
    const row = await this.prisma.withTenant(getTenantId(), (tx) =>
      tx.connector.findUnique({ where: { connectorId: id } }),
    );
    if (!row) throw new NotFoundException('connector not found');
    const { secretRef: _s, ...safe } = row;
    return safe;
  }

  async create(dto: CreateConnectorDto) {
    const tenantId = getTenantId();
    if (!tenantId) throw new BadRequestException('no tenant in context');

    let definitionId = dto.connectorDefinitionId;
    let definition: ConnectorDefinition | undefined;

    if (dto.presetId) {
      definition = this.applyCreateOverrides(this.definitions.getBuiltin(dto.presetId), dto);
    } else if (definitionId) {
      definition = this.applyCreateOverrides(await this.definitions.get(definitionId), dto);
    }

    const secretRef = dto.authSecret ? await this.secrets.storeSecret(dto.authSecret) : undefined;

    return this.prisma.withTenant(tenantId, async (tx) => {
      if (!definitionId && dto.presetId) {
        const preset = await tx.connectorDefinition.findFirst({
          where: { builtIn: true, name: definition?.name },
        });
        definitionId = preset?.definitionId;
      }

      const created = await tx.connector.create({
        data: {
          tenantId,
          connectorDefinitionId: definitionId,
          displayName: dto.displayName,
          provider: dto.provider ?? definition?.provider ?? 'custom',
          category: dto.category ?? definition?.category ?? 'custom',
          kind: dto.presetId ?? 'api_connector',
          config: JSON.parse(JSON.stringify({
            ...(dto.configJson ?? {}),
            baseUrl: dto.baseUrl ?? definition?.baseUrl,
            definition,
          })) as Prisma.InputJsonValue,
          secretRef,
          mappingOverridesJson: (dto.mappingOverridesJson ?? {}) as Prisma.InputJsonValue,
          scheduleJson: (dto.scheduleJson ?? definition?.schedule ?? {}) as Prisma.InputJsonValue,
          status: secretRef ? 'connected' : 'draft',
          enabled: dto.enabled !== false,
        },
      });

      await recordAudit(tx, {
        action: 'create',
        object: `connector:${created.connectorId}`,
        before: null,
        after: { ...created, secretRef: secretRef ? '[stored]' : null },
      });

      const { secretRef: _s, ...safe } = created;
      return safe;
    });
  }

  async update(id: string, dto: Partial<CreateConnectorDto>) {
    const tenantId = getTenantId();
    let secretRef: string | undefined;
    if (dto.authSecret) {
      const existing = await this.prisma.withTenant(tenantId!, (tx) =>
        tx.connector.findUnique({ where: { connectorId: id } }),
      );
      if (existing?.secretRef) await this.secrets.deleteSecret(existing.secretRef);
      secretRef = await this.secrets.storeSecret(dto.authSecret);
    }

    return this.prisma.withTenant(tenantId!, async (tx) => {
      const before = await tx.connector.findUnique({ where: { connectorId: id } });
      if (!before) throw new NotFoundException('connector not found');

      const updated = await tx.connector.update({
        where: { connectorId: id },
        data: {
          displayName: dto.displayName,
          provider: dto.provider,
          category: dto.category,
          config: dto.configJson
            ? (JSON.parse(JSON.stringify({ ...(before.config as object), ...dto.configJson })) as Prisma.InputJsonValue)
            : undefined,
          mappingOverridesJson: dto.mappingOverridesJson as Prisma.InputJsonValue | undefined,
          scheduleJson: dto.scheduleJson as Prisma.InputJsonValue | undefined,
          secretRef,
          enabled: dto.enabled,
          status: secretRef ? 'connected' : undefined,
        },
      });

      await recordAudit(tx, {
        action: 'update',
        object: `connector:${id}`,
        before,
        after: { ...updated, secretRef: updated.secretRef ? '[stored]' : null },
      });

      const { secretRef: _s, ...safe } = updated;
      return safe;
    });
  }

  async delete(id: string) {
    return this.prisma.withTenant(getTenantId(), async (tx) => {
      const before = await tx.connector.findUnique({ where: { connectorId: id } });
      if (!before) throw new NotFoundException('connector not found');
      if (before.secretRef) await this.secrets.deleteSecret(before.secretRef);
      await tx.connector.delete({ where: { connectorId: id } });
      await recordAudit(tx, { action: 'delete', object: `connector:${id}`, before, after: null });
      return { deleted: true };
    });
  }

  async testConnection(id: string, inlineSecret?: string) {
    const preview = await this.preview(id, inlineSecret);
    return {
      ok: preview.errors.length === 0,
      status: preview.ok ? 'connected' : 'validation_failed',
      sampleRecordCount: preview.sampleRecords.length,
      validationErrors: preview.errors,
    };
  }

  async preview(id: string, inlineSecret?: string, range?: { from?: string; to?: string }) {
    const row = await this.prisma.withTenant(getTenantId(), (tx) =>
      tx.connector.findUnique({ where: { connectorId: id } }),
    );
    if (!row) throw new NotFoundException('connector not found');

    const definition = await this.resolveDefinition(row);
    const secret = inlineSecret ?? (await this.secrets.resolveSecret(row.secretRef));
    const creds = this.parseCredentials(secret, definition.authType);

    const { syncStart, syncEnd } = resolveSyncWindow(range?.from, range?.to);

    try {
      const result = await fetchPreviewPage({
        tenantId: row.tenantId,
        connectorId: row.connectorId,
        syncRunId: 'preview',
        definition,
        credentials: creds,
        syncStart,
        syncEnd,
        configOverrides: row.mappingOverridesJson as Record<string, unknown>,
      });

      const normalizedPreview = result.records.map((r) => toImportRow(r));

      await this.prisma.withTenant(getTenantId(), async (tx) => {
        await recordAudit(tx, {
          action: 'update',
          object: `connector:${id}:test`,
          before: null,
          after: { action: 'test', recordCount: result.records.length },
        });
        if (row.status === 'rate_limited') {
          await tx.connector.update({
            where: { connectorId: id },
            data: {
              status: 'connected',
              lastErrorCode: null,
              lastErrorMessageSafe: null,
            },
          });
        }
      });

      return {
        ok: true,
        rawResponse: sanitizeForPreview(result.rawResponse),
        sampleRecords: result.records.slice(0, 10),
        normalizedPreview: normalizedPreview.slice(0, 10),
        suggestedMappings: result.suggestedMappings,
        errors: result.errors,
        warning:
          result.records.length === 0 && anthropicCostBucketsEmpty(result.rawResponse)
            ? NO_COST_ROWS_WARNING
            : undefined,
      };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const msg =
        err.code === 'RATE_LIMITED'
          ? `${safeErrorMessage(err.message ?? 'rate limit exceeded')} Wait ~60s before retrying.`
          : safeErrorMessage(err.message ?? 'request failed');
      return {
        ok: false,
        rawResponse: null,
        sampleRecords: [],
        normalizedPreview: [],
        suggestedMappings: [],
        errors: [{ recordRef: 'request', code: err.code ?? 'REQUEST_FAILED', message: msg }],
      };
    }
  }

  async sync(id: string, range?: { from?: string; to?: string }) {
    const tenantId = getTenantId();
    const row = await this.prisma.withTenant(tenantId!, (tx) =>
      tx.connector.findUnique({ where: { connectorId: id } }),
    );
    if (!row) throw new NotFoundException('connector not found');
    if (!row.enabled) throw new BadRequestException('connector is disabled');

    const definition = await this.resolveDefinition(row);
    const secret = await this.secrets.resolveSecret(row.secretRef);
    if (!secret && definition.authType !== 'none') {
      throw new BadRequestException('connector has no credentials');
    }
    const creds = this.parseCredentials(secret, definition.authType);

    const { syncStart, syncEnd } = resolveSyncWindow(range?.from, range?.to);

    const syncRun = await this.prisma.withTenant(tenantId!, (tx) =>
      tx.connectorSyncRun.create({
        data: { tenantId: tenantId!, connectorId: id, status: 'running' },
      }),
    );

    await this.prisma.withTenant(tenantId!, (tx) =>
      tx.connector.update({
        where: { connectorId: id },
        data: { status: 'syncing', lastSyncStartedAt: new Date() },
      }),
    );

    try {
      const fetched = await fetchAllRecords({
        tenantId: tenantId!,
        connectorId: id,
        syncRunId: syncRun.syncRunId,
        definition,
        credentials: creds,
        syncStart,
        syncEnd,
        lastSuccessAt: row.lastSuccessAt ?? undefined,
        configOverrides: row.mappingOverridesJson as Record<string, unknown>,
      });

      let netSpend = 0;
      let grossSpend = 0;
      let tokenCount = 0;
      let requestCount = fetched.requestCount;
      const importRows = fetched.records.map(toImportRow);

      for (const r of fetched.records) {
        const cost = Number(r.metrics.cost_usd ?? 0);
        netSpend += cost;
        grossSpend += Number(r.metrics.gross_cost_usd ?? cost);
        tokenCount += Number(r.metrics.input_tokens ?? 0) + Number(r.metrics.output_tokens ?? 0);
      }

      const importSummary = importRows.length
        ? await this.importService.importEvents({
            events: importRows as unknown as Record<string, unknown>[],
          })
        : { imported: 0, skipped: 0, events: 0, received: 0, keyless: 0, byTable: {}, dryRun: false };

      await this.prisma.withTenant(tenantId!, async (tx) => {
        for (const rec of fetched.records) {
          await tx.normalizedExternalRecord
            .create({
              data: {
                tenantId: tenantId!,
                connectorId: id,
                syncRunId: syncRun.syncRunId,
                sourceType: 'api',
                recordType: rec.record_type,
                provider: rec.provider,
                externalRecordId: rec.lineage.external_record_id,
                dedupeHash: rec.lineage.dedupe_hash,
                periodStart: rec.period_start ? new Date(rec.period_start) : null,
                periodEnd: rec.period_end ? new Date(rec.period_end) : null,
                ts: new Date(rec.ts),
                normalizedJson: rec.metrics as Prisma.InputJsonValue,
              },
            })
            .catch(() => {
              // Duplicate dedupe_hash — expected on overlapping sync windows.
            });
        }

        for (const err of fetched.errors) {
          await tx.connectorSyncError.create({
            data: {
              tenantId: tenantId!,
              connectorId: id,
              syncRunId: syncRun.syncRunId,
              recordRef: err.recordRef,
              errorCode: err.code,
              errorMessageSafe: err.message,
            },
          });
        }

        const status =
          fetched.errors.length && !fetched.records.length
            ? 'validation_failed'
            : importSummary.imported > 0
              ? 'healthy'
              : fetched.records.length > 0
                ? 'connected'
                : row.status === 'healthy' || row.status === 'connected'
                  ? row.status
                  : 'connected';

        await tx.connectorSyncRun.update({
          where: { syncRunId: syncRun.syncRunId },
          data: {
            status: 'completed',
            completedAt: new Date(),
            recordsSeen: fetched.records.length + fetched.errors.length,
            recordsImported: importSummary.imported,
            recordsRejected: fetched.errors.length,
            netSpendImportedUsd: netSpend,
            grossSpendImportedUsd: grossSpend,
            requestCountImported: requestCount,
            tokenCountImported: BigInt(tokenCount),
          },
        });

        await tx.connector.update({
          where: { connectorId: id },
          data: {
            status,
            lastSyncAt: new Date(),
            lastSyncCompletedAt: new Date(),
            lastSuccessAt: importSummary.imported > 0 ? new Date() : row.lastSuccessAt,
            syncCursor: (fetched.finalCursor
              ? { cursor: fetched.finalCursor }
              : row.syncCursor) as Prisma.InputJsonValue,
            lastError: null,
            lastErrorCode: null,
            lastErrorMessageSafe: null,
          },
        });

        await recordAudit(tx, {
          action: 'update',
          object: `connector:${id}:sync`,
          before: null,
          after: {
            syncRunId: syncRun.syncRunId,
            imported: importSummary.imported,
            skipped: importSummary.skipped,
            rejected: fetched.errors.length,
          },
        });
      });

      this.logger.log(
        { event: 'connector_sync', connectorId: id, imported: importSummary.imported, skipped: importSummary.skipped },
        'connector sync complete',
      );

      return {
        syncRunId: syncRun.syncRunId,
        status: 'completed',
        recordsSeen: fetched.records.length + fetched.errors.length,
        recordsImported: importSummary.imported,
        recordsRejected: fetched.errors.length,
        netSpendImportedUsd: netSpend,
        tokenCountImported: tokenCount,
        emptyWarning:
          fetched.records.length === 0
            ? NO_COST_ROWS_WARNING
            : importSummary.imported === 0 && fetched.records.length > 0
              ? 'Records were fetched but all were skipped as duplicates from a prior import or sync.'
              : undefined,
        duplicateWarning: importSummary.skipped > 0
          ? 'Some records were skipped as duplicates — they may overlap with prior CSV imports or syncs.'
          : undefined,
      };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const code = err.code ?? 'SYNC_FAILED';
      const msg =
        code === 'RATE_LIMITED'
          ? `${safeErrorMessage(err.message ?? 'rate limit exceeded')} Wait ~60s, then click Sync now once.`
          : safeErrorMessage(err.message ?? 'sync failed');

      await this.prisma.withTenant(tenantId!, async (tx) => {
        await tx.connectorSyncRun.update({
          where: { syncRunId: syncRun.syncRunId },
          data: { status: 'failed', completedAt: new Date(), errorCode: code, errorMessageSafe: msg },
        });
        await tx.connector.update({
          where: { connectorId: id },
          data: {
            status:
              code === 'AUTH_FAILED'
                ? 'auth_failed'
                : code === 'RATE_LIMITED'
                  ? 'connected'
                  : 'degraded',
            lastErrorCode: code,
            lastErrorMessageSafe: msg,
            lastSyncCompletedAt: new Date(),
          },
        });
      });

      throw new BadRequestException(msg);
    }
  }

  listSyncRuns(id: string, page: Page) {
    return this.prisma.withTenant(getTenantId(), (tx) =>
      tx.connectorSyncRun.findMany({
        where: { connectorId: id },
        take: page.limit,
        skip: page.offset,
        orderBy: { startedAt: 'desc' },
      }),
    );
  }

  listErrors(id: string, page: Page) {
    return this.prisma.withTenant(getTenantId(), (tx) =>
      tx.connectorSyncError.findMany({
        where: { connectorId: id },
        take: page.limit,
        skip: page.offset,
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}

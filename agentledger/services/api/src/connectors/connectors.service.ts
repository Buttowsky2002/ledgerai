import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantId } from '../tenant/tenant-context';
import { recordAudit } from '../common/audit';
import { Page } from '../common/pagination';
import { ImportService } from '../import/import.service';
import { AnalyticsStore } from '../analytics-store/analytics-store';
import { ConnectorDefinitionsService } from './connector-definitions.service';
import { ConnectorSecretsService } from './connector-secrets.service';
import { fetchPreviewPage } from './engine/connector-engine';
import type { ApiCredentials } from './engine/api-client';
import { sanitizeForPreview, safeErrorMessage } from './engine/sanitizer';
import { DEFAULT_BACKFILL_DAYS, resolvePreviewWindow, resolveSyncChunks } from './sync-range';
import {
  dayBeforeIso,
  readConnectorHandoff,
  resolveConnectorSyncRange,
  resolveFirstSyncBaseline,
  shouldLockApiSyncBaseline,
} from './sync-handoff';
import { ConnectorDefinition } from './types/connector-definition';
import { toImportRow } from './types/normalized-record';
import { runSyncOrchestrator } from './sync-orchestrator';
import { finalizeConnectorRecord } from './connector-record-pipeline';
import { AttributionMappingsService } from './attribution/attribution-mappings.service';
import {
  attributionWarning,
  resolveCapabilities,
} from './types/connector-capabilities';
import { applyAnthropicKeyRouting } from './anthropic-key-routing';
import { DEFAULT_SYNC_INTERVAL_MINUTES } from './sync-range';

const DEFAULT_CONNECTOR_SCHEDULE = { intervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES, enabled: true };

const NO_COST_ROWS_WARNING =
  'API connected, but no billable cost rows were returned for the selected window. ' +
  'Confirm the Admin API key belongs to an org with Claude usage in this period, then sync again (up to 90 days).';

const NO_USER_ATTRIBUTION_WARNING =
  'Spend imported at org level only — no named users detected. For per-user cost, use an Anthropic ' +
  'Analytics API key (read:analytics scope) from claude.ai Organization settings. Admin API keys ' +
  '(sk-ant-admin) only support org-level cost_report, not user_cost_report.';

/** Built-in presets — UI must not override auth, URL, or endpoints from stale form defaults. */
const LOCKED_BUILTIN_PRESETS = new Set(['anthropic-usage', 'openai-usage', 'cursor-usage']);

function omitSecretRef<T extends { secretRef?: unknown }>(row: T): Omit<T, 'secretRef'> {
  const { secretRef, ...safe } = row;
  void secretRef;
  return safe;
}

/** Reject overlapping syncs unless the prior run looks stale. */
const SYNC_IN_PROGRESS_MS = 15 * 60 * 1000;
/** Brief pause between Anthropic 31-day chunks (rate limiter handles per-request spacing). */
const ANTHROPIC_CHUNK_PAUSE_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    private readonly attributionMappings: AttributionMappingsService,
    private readonly ch: AnalyticsStore,
  ) {}

  private applyCreateOverrides(
    def: ConnectorDefinition,
    dto: CreateConnectorDto,
  ): ConnectorDefinition {
    const cfg = dto.configJson ?? {};
    const locked = LOCKED_BUILTIN_PRESETS.has(def.id ?? '') || LOCKED_BUILTIN_PRESETS.has(dto.presetId ?? '');
    const authType = locked
      ? def.authType
      : ((cfg.authType as ConnectorDefinition['authType']) ?? def.authType);
    const isAnthropicBuiltin = def.id === 'anthropic-usage' || dto.presetId === 'anthropic-usage';
    let endpoints = def.endpoints ? [...def.endpoints] : [];
    const endpointPath = cfg.endpointPath as string | undefined;
    if (endpointPath && !isAnthropicBuiltin && !locked) {
      if (endpoints.length > 0) {
        endpoints[0] = { ...endpoints[0], path: endpointPath };
      } else {
        endpoints = [{ path: endpointPath, method: 'GET' }];
      }
    }
    return {
      ...def,
      baseUrl: locked ? def.baseUrl : (dto.baseUrl ?? def.baseUrl),
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
    if (LOCKED_BUILTIN_PRESETS.has(kind)) {
      return { ...fresh };
    }

    const baseUrl = cfg.baseUrl ? String(cfg.baseUrl) : fresh.baseUrl;

    // Built-in Anthropic/OpenAI presets manage their own endpoints.
    if (kind === 'anthropic-usage' || kind === 'openai-usage') {
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
    const cfg = row.config as Record<string, unknown>;
    if (row.kind && LOCKED_BUILTIN_PRESETS.has(row.kind)) {
      return this.mergeBuiltinDefinition(row.kind, cfg);
    }
    if (row.connectorDefinitionId) {
      return this.definitions.get(row.connectorDefinitionId);
    }
    if (row.kind && this.definitions.listBuiltin().some((p) => p.id === row.kind)) {
      return this.mergeBuiltinDefinition(row.kind, cfg);
    }
    const fromConfig = this.resolveStoredDefinition(cfg);
    if (fromConfig) return fromConfig;
    throw new BadRequestException('connector has no definition');
  }

  private parseCredentials(secret: string | undefined, authType?: string): ApiCredentials {
    if (!secret) return {};
    const trimmed = secret.trim();
    if (authType === 'basic_auth') {
      if (!trimmed.includes(':')) {
        return { username: trimmed, password: '' };
      }
      const [username, ...rest] = trimmed.split(':');
      return { username, password: rest.join(':') };
    }
    if (authType === 'custom_header') {
      const [name, ...rest] = trimmed.split('=');
      return { customHeader: { name, value: rest.join('=') } };
    }
    if (authType === 'bearer_token') return { bearerToken: trimmed };
    return { apiKey: trimmed };
  }

  /** Encrypted connector secret first; Anthropic Admin env fallback for headless sync only. */
  private async resolveProviderSecret(
    row: { secretRef?: string | null; kind?: string | null },
    definition: ConnectorDefinition,
    inlineSecret?: string,
  ): Promise<string | undefined> {
    const stored = inlineSecret ?? (await this.secrets.resolveSecret(row.secretRef));
    if (stored?.trim()) return stored.trim();
    if (
      (definition.provider === 'anthropic' || row.kind === 'anthropic-usage') &&
      process.env.ANTHROPIC_ADMIN_API_KEY?.trim()
    ) {
      return process.env.ANTHROPIC_ADMIN_API_KEY.trim();
    }
    return undefined;
  }

  async list(page: Page) {
    const tenantId = getTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.connector.findMany({
        take: page.limit,
        skip: page.offset,
        orderBy: { connectorId: 'asc' },
      });
      const connectorIds = rows.map((r) => r.connectorId);
      const runs =
        connectorIds.length > 0
          ? await tx.connectorSyncRun.findMany({
              where: { connectorId: { in: connectorIds }, status: 'completed' },
              orderBy: { completedAt: 'desc' },
            })
          : [];
      const latestByConnector = new Map<string, (typeof runs)[number]>();
      for (const run of runs) {
        if (!latestByConnector.has(run.connectorId)) {
          latestByConnector.set(run.connectorId, run);
        }
      }

      return rows.map((row) => {
        const safe = omitSecretRef(row);
        const latestRun = latestByConnector.get(row.connectorId);
        const presetId = row.kind ?? undefined;
        const capabilities = resolveCapabilities(presetId);
        return {
          ...safe,
          syncStatus: {
            lastSyncAt: row.lastSuccessAt ?? row.lastSyncCompletedAt,
            lastSyncStatus: latestRun?.status ?? row.status,
            recordsImported: latestRun?.recordsImported ?? 0,
            usersDetected: latestRun?.usersDetected ?? 0,
            unmappedRecords: latestRun?.unmappedRecords ?? 0,
            spendSyncedUsd: Number(latestRun?.netSpendImportedUsd ?? 0),
            errorMessage: row.lastErrorMessageSafe,
          },
          capabilities,
          attributionWarning: attributionWarning(capabilities),
        };
      });
    });
  }

  async get(id: string) {
    const row = await this.prisma.withTenant(getTenantId(), (tx) =>
      tx.connector.findUnique({ where: { connectorId: id } }),
    );
    if (!row) throw new NotFoundException('connector not found');
    const safe = omitSecretRef(row);
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

    const secretRef = dto.authSecret?.trim()
      ? await this.secrets.storeSecret(dto.authSecret.trim())
      : undefined;

    const created = await this.prisma.withTenant(tenantId, async (tx) => {
      if (!definitionId && dto.presetId) {
        const preset = await tx.connectorDefinition.findFirst({
          where: { builtIn: true, name: definition?.name },
        });
        definitionId = preset?.definitionId;
      }

      const row = await tx.connector.create({
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
          scheduleJson: (dto.scheduleJson ?? definition?.schedule ?? DEFAULT_CONNECTOR_SCHEDULE) as Prisma.InputJsonValue,
          status: secretRef ? 'connected' : 'draft',
          enabled: dto.enabled !== false,
        },
      });

      await recordAudit(tx, {
        action: 'create',
        object: `connector:${row.connectorId}`,
        before: null,
        after: { ...row, secretRef: secretRef ? '[stored]' : null },
      });

      return row;
    });

    const safe = omitSecretRef(created);

    if (secretRef && dto.enabled !== false) {
      void this.sync(created.connectorId, { from: undefined, to: undefined }).catch((e) => {
        this.logger.warn(
          { connectorId: created.connectorId, err: safeErrorMessage((e as Error).message) },
          'initial sync after create failed',
        );
      });
    }

    return safe;
  }

  async update(id: string, dto: Partial<CreateConnectorDto>) {
    const tenantId = getTenantId();
    let secretRef: string | undefined;
    if (dto.authSecret?.trim()) {
      const existing = await this.prisma.withTenant(tenantId!, (tx) =>
        tx.connector.findUnique({ where: { connectorId: id } }),
      );
      if (existing?.secretRef) await this.secrets.deleteSecret(existing.secretRef);
      secretRef = await this.secrets.storeSecret(dto.authSecret.trim());
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

      const safe = omitSecretRef(updated);
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

    const definitionBase = await this.resolveDefinition(row);
    const secret = await this.resolveProviderSecret(row, definitionBase, inlineSecret);
    const definition = applyAnthropicKeyRouting(definitionBase, secret);
    const creds = this.parseCredentials(secret, definition.authType);

    const maxDaysPerRequest = definition.syncRange?.maxDaysPerRequest ?? undefined;
    const { syncStart, syncEnd } = resolvePreviewWindow(range?.from, range?.to, 30, maxDaysPerRequest);

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

      const mappings = await this.attributionMappings.loadForConnector(id);
      const finalized = result.records.map((r) =>
        finalizeConnectorRecord(r, definition, mappings, []).record,
      );
      const normalizedPreview = finalized.map((r) => toImportRow(r));
      const previewSpend = normalizedPreview.reduce(
        (sum, row) => sum + Number(row.cost_usd ?? 0),
        0,
      );

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
        sampleRecords: finalized.slice(0, 10),
        normalizedPreview: normalizedPreview.slice(0, 10),
        suggestedMappings: result.suggestedMappings,
        errors: result.errors,
        warning:
          result.records.length === 0 && anthropicCostBucketsEmpty(result.rawResponse)
            ? NO_COST_ROWS_WARNING
            : result.records.length > 0 && previewSpend <= 0
              ? 'API returned usage rows but no billable cost. Check your admin API key and billing endpoint, or confirm the org has usage in this date range.'
              : undefined,
      };
    } catch (e) {
      const err = e as { code?: string; message?: string; statusCode?: number };
      let msg =
        err.code === 'RATE_LIMITED'
          ? `${safeErrorMessage(err.message ?? 'rate limit exceeded')} Wait ~60s before retrying.`
          : safeErrorMessage(err.message ?? 'request failed');
      if (err.code === 'AUTH_FAILED' && definition.provider === 'anthropic') {
        msg +=
          ' Use an Anthropic Organization Analytics API key (read:analytics) from claude.ai → Settings → Organization → API keys — not a regular sk-ant-api chat key.';
      }
      if (err.code === 'AUTH_FAILED' && definition.provider === 'cursor') {
        msg += ' Use a Cursor Team Admin API key from cursor.com → Team settings → Admin API.';
      }
      if (err.code === 'NETWORK_ERROR') {
        msg += ' Check base URL and that the API container can reach the internet.';
      }
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
    if (row.kind === 'github-copilot-business') {
      throw new BadRequestException(
        'GitHub Copilot Business uses the dedicated Copilot sync API. Open Overview → GitHub Copilot Business → Sync now, or POST /v1/github-copilot/connections/:connectionId/sync.',
      );
    }
    if (!row.enabled) throw new BadRequestException('connector is disabled');

    if (row.status === 'syncing' && row.lastSyncStartedAt) {
      const elapsed = Date.now() - row.lastSyncStartedAt.getTime();
      if (elapsed < SYNC_IN_PROGRESS_MS) {
        throw new BadRequestException(
          'This connector is already syncing. Large date ranges can take several minutes — wait for the current run to finish.',
        );
      }
      this.logger.warn(
        { connectorId: id, elapsedMs: elapsed },
        'resetting stale connector sync state',
      );
    }

    const definitionBase = await this.resolveDefinition(row);
    const secret = await this.resolveProviderSecret(row, definitionBase);
    if (!secret && definitionBase.authType !== 'none') {
      throw new BadRequestException('connector has no credentials');
    }
    const definition = applyAnthropicKeyRouting(definitionBase, secret);
    const creds = this.parseCredentials(secret, definition.authType);

    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const handoff = readConnectorHandoff(cfg);
    const effectiveRange = resolveConnectorSyncRange(range, cfg);
    if (effectiveRange === null) {
      throw new BadRequestException(
        handoff.apiSyncBaselineFrom
          ? `Already synced through ${dayBeforeIso(handoff.apiSyncBaselineFrom)}. Choose a To date on or after ${handoff.apiSyncBaselineFrom}, or widen the range for a re-backfill.`
          : 'no sync window to process',
      );
    }
    const maxDaysPerRequest = definition.syncRange?.maxDaysPerRequest ?? undefined;
    const backfillDays = definition.syncRange?.defaultBackfillDays ?? DEFAULT_BACKFILL_DAYS;
    const chunks = resolveSyncChunks(effectiveRange.from, effectiveRange.to, backfillDays, maxDaysPerRequest);
    if (chunks.length === 0) {
      throw new BadRequestException(
        handoff.apiSyncBaselineFrom
          ? `API sync starts at ${handoff.apiSyncBaselineFrom} (portal handoff). Choose a range on or after that date.`
          : 'no sync window to process',
      );
    }
    const overallStart = chunks[0].syncStart;
    const overallEnd = chunks[chunks.length - 1].syncEnd;

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
      const mappings = await this.attributionMappings.loadForConnector(id);
      const presetId = row.kind ?? definition.id;

      let netSpend = 0;
      let grossSpend = 0;
      let tokenCount = 0;
      let requestCount = 0;
      let allRecords: Awaited<ReturnType<typeof runSyncOrchestrator>>['records'] = [];
      let allErrors: Awaited<ReturnType<typeof runSyncOrchestrator>>['errors'] = [];
      let allEntities: Awaited<ReturnType<typeof runSyncOrchestrator>>['entities'] = [];
      let stepsCompleted: string[] = [];
      let capabilities = resolveCapabilities(presetId);
      let usersDetected = 0;
      let unmappedRecords = 0;
      let finalCursor: string | undefined;
      let importSummary = {
        imported: 0,
        skipped: 0,
        events: 0,
        received: 0,
        keyless: 0,
        byTable: {} as Record<string, number>,
        dryRun: false,
      };
      let keysReleased = false;

      if (definition.provider === 'cursor') {
        await this.purgeProviderApiImports(tenantId!, 'cursor', overallStart, overallEnd);
        await this.importService.releaseConnectorImportKeys(id);
        keysReleased = true;
      }

      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const fetched = await runSyncOrchestrator({
          tenantId: tenantId!,
          connectorId: id,
          syncRunId: syncRun.syncRunId,
          definition,
          presetId,
          credentials: creds,
          syncStart: chunk.syncStart,
          syncEnd: chunk.syncEnd,
          lastSuccessAt: row.lastSuccessAt ?? undefined,
          configOverrides: row.mappingOverridesJson as Record<string, unknown>,
          mappings,
        });

        requestCount += fetched.requestCount;
        allRecords = allRecords.concat(fetched.records);
        allErrors = allErrors.concat(fetched.errors);
        if (fetched.entities.length > 0) allEntities = fetched.entities;
        stepsCompleted = fetched.stepsCompleted;
        capabilities = fetched.capabilities;
        usersDetected = fetched.usersDetected;
        unmappedRecords = fetched.unmappedRecords;
        finalCursor = fetched.finalCursor ?? finalCursor;

        for (const r of fetched.records) {
          const cost = Number(r.metrics.cost_usd ?? 0);
          netSpend += cost;
          grossSpend += Number(r.metrics.gross_cost_usd ?? cost);
          tokenCount += Number(r.metrics.input_tokens ?? 0) + Number(r.metrics.output_tokens ?? 0);
        }

        if (netSpend > 0 && !keysReleased) {
          await this.purgeZeroCostApiImports(tenantId!, overallStart, overallEnd);
          await this.importService.releaseConnectorImportKeys(id);
          keysReleased = true;
        }

        const importRows = fetched.records.map(toImportRow);
        if (importRows.length) {
          const chunkSummary = await this.importService.importEvents({
            events: importRows as unknown as Record<string, unknown>[],
          });
          importSummary = {
            ...chunkSummary,
            imported: importSummary.imported + chunkSummary.imported,
            skipped: importSummary.skipped + chunkSummary.skipped,
            events: importSummary.events + chunkSummary.events,
            received: importSummary.received + chunkSummary.received,
            keyless: importSummary.keyless + chunkSummary.keyless,
            byTable: Object.fromEntries(
              [...new Set([...Object.keys(importSummary.byTable), ...Object.keys(chunkSummary.byTable)])].map(
                (table) => [
                  table,
                  (importSummary.byTable[table] ?? 0) + (chunkSummary.byTable[table] ?? 0),
                ],
              ),
            ),
          };
        }

        if (chunkIdx < chunks.length - 1 && definition.provider === 'anthropic') {
          await sleep(ANTHROPIC_CHUNK_PAUSE_MS);
        }
      }

      const fetched = {
        records: allRecords,
        errors: allErrors,
        requestCount,
        entities: allEntities,
        usersDetected,
        unmappedRecords,
        stepsCompleted,
        capabilities,
        finalCursor,
      };

      let nextConfig = cfg;
      await this.prisma.withTenant(tenantId!, async (tx) => {
        if (fetched.entities.length > 0) {
          for (const entity of fetched.entities) {
            await tx.connectorProviderEntity.upsert({
              where: {
                tenantId_connectorId_entityType_providerKey: {
                  tenantId: tenantId!,
                  connectorId: id,
                  entityType: entity.entityType,
                  providerKey: entity.providerKey,
                },
              },
              create: {
                tenantId: tenantId!,
                connectorId: id,
                entityType: entity.entityType,
                providerKey: entity.providerKey,
                displayName: entity.displayName,
                email: entity.email,
              },
              update: {
                displayName: entity.displayName,
                email: entity.email,
                lastSeenAt: new Date(),
              },
            });
          }
        }

        if (fetched.records.length > 0) {
          await tx.normalizedExternalRecord.createMany({
            data: fetched.records.map((rec) => ({
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
            })),
            skipDuplicates: true,
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
            usersDetected: fetched.usersDetected,
            unmappedRecords: fetched.unmappedRecords,
          },
        });

        const syncEndDay = overallEnd.toISOString().slice(0, 10);
        const coveredDays =
          Math.floor((overallEnd.getTime() - overallStart.getTime()) / 86_400_000) + 1;
        if (
          !handoff.apiSyncBaselineFrom &&
          (importSummary.imported > 0 || netSpend > 0) &&
          shouldLockApiSyncBaseline({
            portalImportThrough: handoff.portalImportThrough,
            coveredDays,
            defaultBackfillDays: backfillDays,
          })
        ) {
          nextConfig = {
            ...cfg,
            apiSyncBaselineFrom: resolveFirstSyncBaseline(handoff.portalImportThrough, syncEndDay),
          };
        }

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
            config: nextConfig as Prisma.InputJsonValue,
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
        usersDetected: fetched.usersDetected,
        unmappedRecords: fetched.unmappedRecords,
        stepsCompleted: fetched.stepsCompleted,
        capabilities: fetched.capabilities,
        attributionWarning: attributionWarning(fetched.capabilities),
        userAttributionWarning:
          (presetId === 'anthropic-usage' || definition.provider === 'anthropic') &&
          fetched.usersDetected === 0 &&
          fetched.records.length > 0
            ? NO_USER_ATTRIBUTION_WARNING
            : undefined,
        emptyWarning:
          fetched.records.length === 0
            ? NO_COST_ROWS_WARNING
            : importSummary.imported === 0 && fetched.records.length > 0
              ? 'Records were fetched but all were skipped as duplicates from a prior import or sync.'
              : undefined,
        duplicateWarning: importSummary.skipped > 0
          ? 'Some records were skipped as duplicates — they may overlap with prior CSV imports or syncs.'
          : undefined,
        handoff: readConnectorHandoff(nextConfig),
        syncRangeApplied: {
          from: overallStart.toISOString().slice(0, 10),
          to: overallEnd.toISOString().slice(0, 10),
          clampedToBaseline: Boolean(
            handoff.apiSyncBaselineFrom &&
              range?.from &&
              range.from.slice(0, 10) < handoff.apiSyncBaselineFrom,
          ),
        },
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

  /** Remove prior zero-cost API imports in the sync window so a backfill can replace them. */
  private async purgeZeroCostApiImports(tenantId: string, syncStart: Date, syncEnd: Date): Promise<void> {
    const from = syncStart.toISOString().slice(0, 10);
    const to = syncEnd.toISOString().slice(0, 10);
    await this.ch.command(
      `ALTER TABLE llm_calls DELETE WHERE tenant_id = {tenant:String} AND source = 'api' AND cost_usd = 0 AND usage_value_usd = 0 AND toDate(ts) >= {from:Date} AND toDate(ts) <= {to:Date}`,
      { tenant: tenantId, from, to },
    );
  }

  /** Drop provider API rows in the sync window before a billing re-sync (avoids duplicate llm_calls). */
  private async purgeProviderApiImports(
    tenantId: string,
    provider: string,
    syncStart: Date,
    syncEnd: Date,
  ): Promise<void> {
    const from = syncStart.toISOString().slice(0, 10);
    const to = syncEnd.toISOString().slice(0, 10);
    await this.ch.command(
      `ALTER TABLE llm_calls DELETE WHERE tenant_id = {tenant:String} AND source = 'api' AND provider = {provider:String} AND toDate(ts) >= {from:Date} AND toDate(ts) <= {to:Date}`,
      { tenant: tenantId, provider, from, to },
    );
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

import {
  ConnectorDefinition,
  SupplementalFetchConfig,
  TemplateContext,
} from '../types/connector-definition';
import { NormalizedRecord, suggestMappings } from '../types/normalized-record';
import { computeDedupeHash } from './dedupe';
import { executeWithRetry } from './api-client';
import type { ApiCredentials, ApiRequestResult } from './api-client';
import { ConnectorError } from '../types/connector-definition';
import { mapFields, validateMetrics } from './field-mapper';
import { buildPaginationParams, extractPage } from './pagination';
import { getPath } from './path';
import { stripBlockedFields } from './sanitizer';
import { parseDate } from './field-mapper';

export interface SyncContext {
  tenantId: string;
  connectorId: string;
  syncRunId: string;
  definition: ConnectorDefinition;
  credentials: ApiCredentials;
  syncStart: Date;
  syncEnd: Date;
  lastSuccessAt?: Date;
  configOverrides?: Record<string, unknown>;
}

export interface SyncPageResult {
  records: NormalizedRecord[];
  errors: { recordRef: string; code: string; message: string }[];
  requestCount: number;
  cursor?: string;
}

export interface FetchAllResult {
  records: NormalizedRecord[];
  errors: { recordRef: string; code: string; message: string }[];
  requestCount: number;
  finalCursor?: string;
}

function utcDayIso(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function buildTemplateContext(ctx: SyncContext, extra?: Partial<TemplateContext>): TemplateContext {
  return {
    tenant_id: ctx.tenantId,
    connector_id: ctx.connectorId,
    sync_start: ctx.syncStart.toISOString(),
    sync_end: ctx.syncEnd.toISOString(),
    sync_start_day: utcDayIso(ctx.syncStart),
    sync_end_day: utcDayIso(ctx.syncEnd),
    now: new Date().toISOString(),
    last_success_at: ctx.lastSuccessAt?.toISOString() ?? '',
    page_size: ctx.definition.pagination?.pageSize ?? 100,
    ...extra,
  };
}

function mergeDefinition(
  base: ConnectorDefinition,
  patch: NonNullable<ConnectorDefinition['fallbackDefinition']>,
): ConnectorDefinition {
  return {
    ...base,
    ...patch,
    endpoints: patch.endpoints ?? base.endpoints,
    fieldMappings: patch.fieldMappings ?? base.fieldMappings,
    pagination: patch.pagination ?? base.pagination,
    validationRules: patch.validationRules ?? base.validationRules,
    fallbackDefinition: undefined,
  };
}

function shouldUseFallback(err: unknown): boolean {
  const e = err as ConnectorError;
  if (e.statusCode === 403 || e.statusCode === 404) return true;
  if (e.statusCode === 400) {
    const msg = e.message ?? '';
    return /analytics|enterprise|permission|group_by|invalid/i.test(msg);
  }
  if (e.code === 'AUTH_FAILED' || e.code === 'REQUEST_FAILED') {
    return /analytics|enterprise|not found|permission/i.test(e.message ?? '');
  }
  return false;
}

async function executeConnectorRequest(
  ctx: SyncContext,
  tmplCtx: TemplateContext,
  overrides?: Parameters<typeof executeWithRetry>[3],
): Promise<ApiRequestResult> {
  try {
    return await executeWithRetry(ctx.definition, ctx.credentials, tmplCtx, overrides);
  } catch (err) {
    const fallback = ctx.definition.fallbackDefinition;
    if (!fallback || !shouldUseFallback(err)) throw err;
    const fallbackDef = mergeDefinition(ctx.definition, fallback);
    return executeWithRetry(fallbackDef, ctx.credentials, tmplCtx, overrides);
  }
}

function normalizeRecord(
  raw: Record<string, unknown>,
  ctx: SyncContext,
  index: number,
): { record?: NormalizedRecord; errors: string[] } {
  const stripped = stripBlockedFields(raw);
  const def = ctx.definition;
  const overrides = (ctx.configOverrides?.fieldMappings as typeof def.fieldMappings) ?? [];
  const mappings = [...def.fieldMappings, ...overrides];
  const { metrics, metadata } = mapFields(stripped, mappings);
  const validationErrors = validateMetrics(metrics, def.validationRules);

  if (validationErrors.length) {
    return { errors: validationErrors };
  }

  const externalId = String(metrics.id ?? metrics.record_id ?? metrics.external_id ?? index);
  const dedupeHash = computeDedupeHash(def.dedupe, metrics, externalId);
  const ts = parseDate(metrics.ts ?? metrics.timestamp ?? metrics.period_end) ?? ctx.syncEnd.toISOString();

  const record: NormalizedRecord = {
    tenant_id: ctx.tenantId,
    source: 'api',
    source_type: def.category,
    connector_id: ctx.connectorId,
    connector_sync_run_id: ctx.syncRunId,
    provider: def.provider,
    record_type: def.destinationRecordType,
    period_start: parseDate(metrics.period_start),
    period_end: parseDate(metrics.period_end),
    ts,
    lineage: {
      external_record_id: externalId,
      dedupe_hash: dedupeHash,
      connector_definition_id: def.id,
      raw_metadata: Object.keys(metadata).length ? metadata : undefined,
    },
    metrics,
  };

  return { record, errors: [] };
}

function metricsMergeKey(metrics: Record<string, unknown>, keys: string[]): string {
  return keys.map((k) => String(metrics[k] ?? '')).join('|');
}

function mergeSupplementalMetrics(
  records: NormalizedRecord[],
  supplementalMap: Map<string, Record<string, unknown>>,
  mergeOn: string[],
): NormalizedRecord[] {
  return records.map((rec) => {
    const extra = supplementalMap.get(metricsMergeKey(rec.metrics, mergeOn));
    if (!extra) return rec;
    const metrics = { ...rec.metrics };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === '') continue;
      if (metrics[k] === undefined || metrics[k] === null || metrics[k] === '') {
        metrics[k] = v;
      }
    }
    return { ...rec, metrics };
  });
}

async function fetchSupplementalMetricsMap(
  ctx: SyncContext,
  config: SupplementalFetchConfig,
  maxPages?: number,
): Promise<{
  map: Map<string, Record<string, unknown>>;
  requestCount: number;
  errors: FetchAllResult['errors'];
}> {
  const supplementalDef: ConnectorDefinition = {
    ...ctx.definition,
    endpoints: [config.endpoint],
    pagination: config.pagination ?? { type: 'none' },
    fieldMappings: config.fieldMappings,
    validationRules: config.validationRules,
  };
  const subCtx: SyncContext = { ...ctx, definition: supplementalDef };
  const fetched = await fetchAllRecords(subCtx, maxPages);
  const map = new Map<string, Record<string, unknown>>();
  for (const rec of fetched.records) {
    map.set(metricsMergeKey(rec.metrics, config.mergeOn), rec.metrics);
  }
  return { map, requestCount: fetched.requestCount, errors: fetched.errors };
}

/** Fetch and normalize all pages from the connector API. */
export async function fetchAllRecords(ctx: SyncContext, maxPages?: number): Promise<FetchAllResult> {
  const def = ctx.definition;
  const pagination = def.pagination ?? { type: 'none' as const };
  const pageSize = pagination.pageSize ?? 100;
  const limit = maxPages ?? pagination.maxPages ?? 50;

  let records: NormalizedRecord[] = [];
  const errors: FetchAllResult['errors'] = [];
  let requestCount = 0;
  let page = 1;
  let offset = 0;
  let cursor: string | undefined;
  let nextUrl: string | undefined;
  let token: string | undefined;
  let finalCursor: string | undefined;

  for (let i = 0; i < limit; i++) {
    const tmplCtx = buildTemplateContext(ctx, { cursor, page, page_size: pageSize });
    const pageParams = buildPaginationParams(pagination, { cursor, page, offset, token }, pageSize);

    const result = await executeConnectorRequest(
      ctx,
      tmplCtx,
      nextUrl ? { url: nextUrl } : { queryParams: pageParams },
    );
    requestCount++;

    const data = def.responseDataPath ? getPath(result.body, def.responseDataPath) ?? result.body : result.body;
    const pageResult = extractPage(data, pagination);

    pageResult.items.forEach((item, idx) => {
      const { record, errors: rowErrors } = normalizeRecord(item, ctx, offset + idx);
      if (rowErrors.length) {
        errors.push({
          recordRef: `row:${offset + idx}`,
          code: 'VALIDATION',
          message: rowErrors.join('; '),
        });
      } else if (record) {
        records.push(record);
      }
    });

    if (!pageResult.hasMore) break;

    cursor = pageResult.nextCursor;
    nextUrl = pageResult.nextUrl;
    token = pageResult.nextToken;
    finalCursor = cursor ?? token ?? String(page + 1);
    page++;
    offset += pageResult.items.length;

    if (pagination.type === 'page' || pagination.type === 'offset') {
      if (pageResult.items.length < pageSize) break;
    }
  }

  if (def.supplementalFetch && records.length > 0) {
    const sup = await fetchSupplementalMetricsMap(ctx, def.supplementalFetch, maxPages);
    requestCount += sup.requestCount;
    errors.push(...sup.errors);
    records = mergeSupplementalMetrics(records, sup.map, def.supplementalFetch.mergeOn);
  }

  return { records, errors, requestCount, finalCursor };
}


/** Fetch a single page for test/preview (no pagination loop). */
export async function fetchPreviewPage(ctx: SyncContext): Promise<{
  rawResponse: unknown;
  records: NormalizedRecord[];
  errors: FetchAllResult['errors'];
  suggestedMappings: ReturnType<typeof suggestMappings>;
}> {
  const tmplCtx = buildTemplateContext(ctx);
  const result = await executeConnectorRequest(ctx, tmplCtx);
  const data = ctx.definition.responseDataPath
    ? getPath(result.body, ctx.definition.responseDataPath) ?? result.body
    : result.body;
  const pageResult = extractPage(data, ctx.definition.pagination);

  const records: NormalizedRecord[] = [];
  const errors: FetchAllResult['errors'] = [];

  pageResult.items.forEach((item, idx) => {
    const { record, errors: rowErrors } = normalizeRecord(item, ctx, idx);
    if (rowErrors.length) {
      errors.push({ recordRef: `row:${idx}`, code: 'VALIDATION', message: rowErrors.join('; ') });
    } else if (record) {
      records.push(record);
    }
  });

  if (ctx.definition.supplementalFetch && records.length > 0) {
    // Token usage is merged on full sync only — skip supplemental fetch on Test preview.
  }

  const sample = pageResult.items[0] ?? {};
  const suggestedMappings = suggestMappings(sample, ctx.definition.destinationRecordType);

  return { rawResponse: result.body, records, errors, suggestedMappings };
}

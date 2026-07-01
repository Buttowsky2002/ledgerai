import { executeWithRetry } from './engine/api-client';
import type { ApiCredentials } from './engine/api-client';
import { fetchAllRecords } from './engine/connector-engine';
import type { FetchAllResult, SyncContext } from './engine/connector-engine';
import { getPath } from './engine/path';
import { extractPage } from './engine/pagination';
import { buildTemplateContext } from './engine/sync-context';
import { finalizeConnectorRecords } from './connector-record-pipeline';
import type { AttributionMapping, ProviderEntity } from './attribution/attribution-resolver';
import {
  type AuxiliaryFetchConfig,
  type ConnectorCapabilities,
  PRESET_AUXILIARY_FETCHES,
  resolveCapabilities,
} from './types/connector-capabilities';
import type { ConnectorDefinition } from './types/connector-definition';

export interface SyncOrchestratorInput {
  tenantId: string;
  connectorId: string;
  syncRunId: string;
  definition: ConnectorDefinition;
  presetId?: string;
  credentials: ApiCredentials;
  syncStart: Date;
  syncEnd: Date;
  lastSuccessAt?: Date;
  configOverrides?: Record<string, unknown>;
  mappings: AttributionMapping[];
}

export interface SyncOrchestratorResult extends FetchAllResult {
  entities: ProviderEntity[];
  usersDetected: number;
  unmappedRecords: number;
  capabilities: ConnectorCapabilities;
  stepsCompleted: string[];
}

async function fetchAuxiliaryEntities(
  ctx: SyncContext,
  config: AuxiliaryFetchConfig,
): Promise<{ entities: ProviderEntity[]; requestCount: number }> {
  const tmplCtx = buildTemplateContext(ctx);
  const auxDef: ConnectorDefinition = {
    ...ctx.definition,
    endpoints: [{ path: config.path, method: config.method ?? 'GET' }],
    pagination: { type: 'none' },
    fieldMappings: [],
  };
  try {
    const result = await executeWithRetry(auxDef, ctx.credentials, tmplCtx);
    const data = config.itemsPath ? getPath(result.body, config.itemsPath) ?? result.body : result.body;
    const page = extractPage(data, { type: 'none' });
    const entities: ProviderEntity[] = page.items.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        entityType: config.step,
        providerKey: String(row[config.idField] ?? ''),
        email: config.emailField ? String(row[config.emailField] ?? '') || undefined : undefined,
        displayName: config.nameField ? String(row[config.nameField] ?? '') || undefined : undefined,
      };
    }).filter((e) => e.providerKey);
    return { entities, requestCount: 1 };
  } catch {
    return { entities: [], requestCount: 0 };
  }
}

/** Full API sync flow: test → fetchUsers/Projects/ApiKeys → fetchUsage → attribute → return. */
export async function runSyncOrchestrator(input: SyncOrchestratorInput): Promise<SyncOrchestratorResult> {
  const capabilities = resolveCapabilities(input.presetId, input.definition.capabilities);
  const presetId = input.presetId ?? input.definition.id ?? '';
  const auxiliaryConfigs = PRESET_AUXILIARY_FETCHES[presetId] ?? [];

  const ctx: SyncContext = {
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    syncRunId: input.syncRunId,
    definition: input.definition,
    credentials: input.credentials,
    syncStart: input.syncStart,
    syncEnd: input.syncEnd,
    lastSuccessAt: input.lastSuccessAt,
    configOverrides: input.configOverrides,
  };

  const stepsCompleted: string[] = ['testConnection'];
  const entities: ProviderEntity[] = [];
  let auxiliaryRequestCount = 0;

  const stepEnabled: Record<string, boolean> = {
    users: capabilities.supportsUsers,
    projects: capabilities.supportsProjects,
    api_keys: capabilities.supportsApiKeys,
    workspaces: capabilities.supportsWorkspaces,
  };

  for (const aux of auxiliaryConfigs) {
    if (!stepEnabled[aux.step]) continue;
    const { entities: fetched, requestCount } = await fetchAuxiliaryEntities(ctx, aux);
    entities.push(...fetched);
    auxiliaryRequestCount += requestCount;
    if (fetched.length > 0) {
      stepsCompleted.push(`fetch${aux.step.charAt(0).toUpperCase()}${aux.step.slice(1)}`);
    }
  }

  stepsCompleted.push('fetchUsage');
  const fetched = await fetchAllRecords(ctx);
  fetched.requestCount += auxiliaryRequestCount;

  const { records, unmappedRecords } = finalizeConnectorRecords(
    fetched.records,
    input.definition,
    input.mappings,
    entities,
  );
  stepsCompleted.push('applyAttribution');

  const usersDetected = new Set(
    records
      .map((r) => String(r.metrics.user_id ?? ''))
      .filter((id) => id && id !== 'Unassigned'),
  ).size;

  return {
    records,
    errors: fetched.errors,
    requestCount: fetched.requestCount,
    finalCursor: fetched.finalCursor,
    entities,
    usersDetected,
    unmappedRecords,
    capabilities,
    stepsCompleted,
  };
}

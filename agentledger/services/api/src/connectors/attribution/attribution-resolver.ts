import { UNASSIGNED_USER, type NormalizedUsageMetrics } from '../types/normalized-usage-event';

export type MappingType =
  | 'provider_user'
  | 'api_key'
  | 'project'
  | 'workspace'
  | 'service_account'
  | 'team';

export interface AttributionMapping {
  mappingType: MappingType;
  providerKey: string;
  targetUserId?: string | null;
  targetTeamId?: string | null;
}

export interface ProviderEntity {
  entityType: string;
  providerKey: string;
  email?: string | null;
  displayName?: string | null;
}

export interface AttributionResult {
  userId: string;
  teamId?: string;
  method: string;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

/** Human-readable label for spend attribution in dashboards. */
export function displayUserLabel(metrics: NormalizedUsageMetrics, resolvedUserId: string): string {
  if (resolvedUserId === UNASSIGNED_USER) return UNASSIGNED_USER;
  const name = str(metrics.user_name);
  const email = str(metrics.user_email);
  if (name && name !== 'Deleted User' && email) return `${name} (${email})`;
  if (email) return email;
  if (name && name !== 'Deleted User') return name;
  return resolvedUserId;
}

function findMapping(
  mappings: AttributionMapping[],
  type: MappingType,
  key: string | undefined,
): AttributionMapping | undefined {
  if (!key) return undefined;
  return mappings.find((m) => m.mappingType === type && m.providerKey === key);
}

function findUserByEmail(entities: ProviderEntity[], email: string): ProviderEntity | undefined {
  const lower = email.toLowerCase();
  return entities.find(
    (e) => e.entityType === 'users' && e.email?.toLowerCase() === lower,
  );
}

/**
 * Resolve user/team attribution using the priority chain:
 * 1. Direct provider user ID
 * 2. User email
 * 3. Internal mapped provider user
 * 4. API key mapping
 * 5. Project mapping
 * 6. Workspace mapping
 * 7. Service account mapping
 * 8. Team mapping
 * 9. Unassigned
 */
export function resolveAttribution(
  metrics: NormalizedUsageMetrics,
  mappings: AttributionMapping[],
  entities: ProviderEntity[] = [],
): AttributionResult {
  const providerUserId = str(metrics.user_id ?? metrics.provider_user_id);
  const userEmail = str(metrics.user_email);
  const apiKeyId = str(metrics.api_key_id);
  const projectId = str(metrics.project_id);
  const workspaceId = str(metrics.workspace_id ?? metrics.project_id);
  const serviceAccountId = str(metrics.service_account_id);
  const teamIdFromMetrics = str(metrics.team_id);

  if (providerUserId) {
    return { userId: providerUserId, teamId: teamIdFromMetrics, method: 'provider_user_id' };
  }

  if (userEmail) {
    const entity = findUserByEmail(entities, userEmail);
    return {
      userId: entity?.providerKey ?? userEmail,
      teamId: teamIdFromMetrics,
      method: entity ? 'user_email_lookup' : 'user_email',
    };
  }

  const mappedUser = findMapping(mappings, 'provider_user', providerUserId);
  if (mappedUser?.targetUserId) {
    return {
      userId: mappedUser.targetUserId,
      teamId: mappedUser.targetTeamId ?? teamIdFromMetrics,
      method: 'mapped_provider_user',
    };
  }

  const apiKeyMapping = findMapping(mappings, 'api_key', apiKeyId);
  if (apiKeyMapping?.targetUserId) {
    return {
      userId: apiKeyMapping.targetUserId,
      teamId: apiKeyMapping.targetTeamId ?? teamIdFromMetrics,
      method: 'api_key_mapping',
    };
  }

  const projectMapping = findMapping(mappings, 'project', projectId);
  if (projectMapping?.targetUserId) {
    return {
      userId: projectMapping.targetUserId,
      teamId: projectMapping.targetTeamId ?? teamIdFromMetrics,
      method: 'project_mapping',
    };
  }

  const workspaceMapping = findMapping(mappings, 'workspace', workspaceId);
  if (workspaceMapping?.targetUserId) {
    return {
      userId: workspaceMapping.targetUserId,
      teamId: workspaceMapping.targetTeamId ?? teamIdFromMetrics,
      method: 'workspace_mapping',
    };
  }

  const saMapping = findMapping(mappings, 'service_account', serviceAccountId);
  if (saMapping?.targetUserId) {
    return {
      userId: saMapping.targetUserId,
      teamId: saMapping.targetTeamId ?? teamIdFromMetrics,
      method: 'service_account_mapping',
    };
  }

  const teamMapping = findMapping(mappings, 'team', teamIdFromMetrics);
  if (teamMapping?.targetTeamId) {
    return {
      userId: teamMapping.targetUserId ?? UNASSIGNED_USER,
      teamId: teamMapping.targetTeamId,
      method: 'team_mapping',
    };
  }

  // Fallback labels when we have a dimension but no user mapping
  if (apiKeyId) {
    return { userId: UNASSIGNED_USER, teamId: teamIdFromMetrics, method: 'unmapped_api_key' };
  }
  if (projectId) {
    return { userId: UNASSIGNED_USER, teamId: teamIdFromMetrics, method: 'unmapped_project' };
  }
  if (workspaceId) {
    return { userId: UNASSIGNED_USER, teamId: teamIdFromMetrics, method: 'unmapped_workspace' };
  }

  return { userId: UNASSIGNED_USER, teamId: teamIdFromMetrics, method: 'unassigned' };
}

export function isUnmapped(result: AttributionResult): boolean {
  return result.userId === UNASSIGNED_USER;
}

/** Apply resolved attribution onto normalized metrics before import. */
export function applyAttributionToMetrics(
  metrics: NormalizedUsageMetrics,
  mappings: AttributionMapping[],
  entities: ProviderEntity[],
): NormalizedUsageMetrics {
  const result = resolveAttribution(metrics, mappings, entities);
  return {
    ...metrics,
    user_id: displayUserLabel(metrics, result.userId),
    team_id: result.teamId ?? metrics.team_id,
    attribution_method: result.method,
  };
}

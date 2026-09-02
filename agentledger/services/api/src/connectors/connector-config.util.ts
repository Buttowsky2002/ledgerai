import { ConnectorDefinition } from './types/connector-definition';
import type { ApiCredentials } from './engine/api-client';

// Pure connector-config helpers extracted verbatim from ConnectorsService so the
// service file stays smaller and each transform is unit-testable in isolation.
// None of these touch `this`, Prisma, or the network — they only reshape a
// ConnectorDefinition or parse a credential string.

/** Built-in presets — UI must not override auth, URL, or endpoints from stale form defaults. */
export const LOCKED_BUILTIN_PRESETS = new Set([
  'anthropic-usage',
  'openai-usage',
  'cursor-usage',
  'azure-devops-outcomes',
]);

/**
 * The subset of CreateConnectorDto that influences a definition. Declared
 * structurally (rather than importing CreateConnectorDto from connectors.service)
 * to avoid a service↔util import cycle; the full DTO is assignable to it.
 */
type CreateOverridesInput = {
  configJson?: Record<string, unknown>;
  presetId?: string;
  baseUrl?: string;
};

export function applyCreateOverrides(
  def: ConnectorDefinition,
  dto: CreateOverridesInput,
): ConnectorDefinition {
  const cfg = dto.configJson ?? {};
  const locked =
    LOCKED_BUILTIN_PRESETS.has(def.id ?? '') || LOCKED_BUILTIN_PRESETS.has(dto.presetId ?? '');
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
      authType === 'api_key_header' ? (def.authHeaderName ?? 'x-api-key') : def.authHeaderName,
    endpoints,
  };
}

export function resolveStoredDefinition(
  cfg: Record<string, unknown>,
): ConnectorDefinition | undefined {
  if (!cfg?.definition) {
    return undefined;
  }
  const def = { ...(cfg.definition as ConnectorDefinition) };
  if (cfg.baseUrl) {
    def.baseUrl = String(cfg.baseUrl);
  }
  const endpointPath = cfg.endpointPath as string | undefined;
  if (endpointPath && def.endpoints?.[0]) {
    def.endpoints = [{ ...def.endpoints[0], path: endpointPath }];
  }
  return def;
}

export function parseCredentials(secret: string | undefined, authType?: string): ApiCredentials {
  if (!secret) {
    return {};
  }
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
  if (authType === 'bearer_token') {
    return { bearerToken: trimmed };
  }
  return { apiKey: trimmed };
}

import type { ConnectorDefinition } from './types/connector-definition';
import { DEFAULT_CAPABILITIES } from './types/connector-capabilities';

/** Route Anthropic sync to the API surface that matches the stored key type. */
export function applyAnthropicKeyRouting(
  def: ConnectorDefinition,
  secret?: string,
): ConnectorDefinition {
  if (def.provider !== 'anthropic' && def.id !== 'anthropic-usage') return def;
  const key = secret?.trim() ?? '';
  if (!key || key.startsWith('sk-ant-admin')) {
    return def;
  }

  const analytics = def.fallbackDefinition;
  if (!analytics?.endpoints?.length || !analytics.fieldMappings?.length) return def;

  return {
    ...def,
    endpoints: analytics.endpoints,
    pagination: analytics.pagination ?? def.pagination,
    fieldMappings: analytics.fieldMappings,
    validationRules: analytics.validationRules ?? def.validationRules,
    fallbackDefinition: {
      endpoints: def.endpoints,
      pagination: def.pagination,
      fieldMappings: def.fieldMappings,
      validationRules: def.validationRules,
    },
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...(def.capabilities ?? {}),
      supportsUserLevelCost: true,
    },
  };
}

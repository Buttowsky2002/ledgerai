import type { Connector, Preset } from '../types/connectors';

export const CATEGORIES = [
  'provider_spend',
  'ai_usage',
  'coding_tool',
  'gateway_logs',
  'observability',
  'cloud_cost',
  'outcome_system',
  'risk_security',
  'custom',
] as const;

export const AUTH_TYPES = [
  'api_key_header',
  'bearer_token',
  'basic_auth',
  'custom_header',
  'none',
] as const;

export const COPILOT_PRESET = 'github-copilot-business';
export const ADO_PRESET = 'azure-devops-outcomes';
export const LOCKED_PRESETS = new Set([
  'anthropic-usage',
  'openai-usage',
  'cursor-usage',
  COPILOT_PRESET,
  ADO_PRESET,
]);

export function isCopilotConnector(c: Connector): boolean {
  return c.provider === 'github_copilot_business' || c.category === 'license_usage_roi';
}

export const PRESET_DEFAULTS: Record<
  string,
  { baseUrl: string; authType: string; endpointPath: string; category: string }
> = {
  'anthropic-usage': {
    baseUrl: 'https://api.anthropic.com',
    authType: 'api_key_header',
    endpointPath: '/v1/organizations/cost_report',
    category: 'provider_spend',
  },
  'openai-usage': {
    baseUrl: 'https://api.openai.com',
    authType: 'bearer_token',
    endpointPath: '/v1/organization/costs',
    category: 'provider_spend',
  },
  'cursor-usage': {
    baseUrl: 'https://api.cursor.com',
    authType: 'basic_auth',
    endpointPath: '/teams/filtered-usage-events',
    category: 'coding_tool',
  },
  'github-copilot-business': {
    baseUrl: 'https://api.github.com',
    authType: 'bearer_token',
    endpointPath: '/orgs/{org}/copilot/billing',
    category: 'license_usage_roi',
  },
  'azure-devops-outcomes': {
    baseUrl: 'https://dev.azure.com',
    authType: 'basic_auth',
    endpointPath: '/',
    category: 'outcome_system',
  },
};

export function presetFormFields(presetId: string, presets: Preset[]) {
  const preset = presets.find((p) => (p.definitionId ?? p.name) === presetId);
  const def = preset?.definitionJson;
  if (def) {
    return {
      presetId,
      category: def.category ?? preset?.category ?? 'provider_spend',
      baseUrl: def.baseUrl ?? 'https://api.example.com',
      authType: def.authType ?? 'api_key_header',
      endpointPath: def.endpoints?.[0]?.path ?? '/v1/spend',
    };
  }
  const fallback = PRESET_DEFAULTS[presetId];
  return fallback ? { presetId, ...fallback } : { presetId };
}

export function formatApiError(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.detail === 'string') {
    return body.detail;
  }
  if (typeof body.message === 'string') {
    return body.message;
  }
  if (body.message && typeof body.message === 'object' && !Array.isArray(body.message)) {
    const nested = body.message as Record<string, unknown>;
    if (typeof nested.message === 'string') {
      return nested.message;
    }
  }
  if (Array.isArray(body.message)) {
    return body.message.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ');
  }
  if (typeof body.error === 'string') {
    return body.error;
  }
  return fallback;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function defaultConnectorRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 89);
  return { from: isoDate(from), to: isoDate(to) };
}

export function statusTone(s: string): string {
  if (s === 'healthy' || s === 'connected') {
    return 'text-pos';
  }
  if (s === 'auth_failed' || s === 'validation_failed') {
    return 'text-neg';
  }
  if (s === 'syncing' || s === 'rate_limited') {
    return 'text-warn';
  }
  return 'text-muted';
}

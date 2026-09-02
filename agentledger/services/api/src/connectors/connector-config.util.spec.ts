import {
  applyCreateOverrides,
  parseCredentials,
  resolveStoredDefinition,
} from './connector-config.util';
import type { ConnectorDefinition } from './types/connector-definition';

function baseDefinition(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    id: 'custom-api',
    name: 'Custom API',
    provider: 'acme',
    category: 'custom',
    authType: 'api_key_header',
    authHeaderName: 'x-api-key',
    baseUrl: 'https://api.acme.test',
    endpoints: [{ path: '/v1/usage', method: 'GET' }],
    fieldMappings: [],
    destinationRecordType: 'spend_usage_record',
    ...overrides,
  };
}

describe('parseCredentials', () => {
  it('returns an empty object when no secret is provided', () => {
    expect(parseCredentials(undefined)).toEqual({});
    expect(parseCredentials('')).toEqual({});
  });

  it('defaults to an api key and trims surrounding whitespace', () => {
    expect(parseCredentials('  sk-123  ')).toEqual({ apiKey: 'sk-123' });
  });

  it('splits basic_auth on the first colon and keeps the rest as the password', () => {
    expect(parseCredentials('user:pass', 'basic_auth')).toEqual({
      username: 'user',
      password: 'pass',
    });
    expect(parseCredentials('user:p:a:ss', 'basic_auth')).toEqual({
      username: 'user',
      password: 'p:a:ss',
    });
  });

  it('treats a basic_auth value with no colon as a username with an empty password', () => {
    expect(parseCredentials('justuser', 'basic_auth')).toEqual({
      username: 'justuser',
      password: '',
    });
  });

  it('splits a custom_header value on the first equals sign', () => {
    expect(parseCredentials('X-Api-Key=secret=value', 'custom_header')).toEqual({
      customHeader: { name: 'X-Api-Key', value: 'secret=value' },
    });
  });

  it('maps a bearer_token', () => {
    expect(parseCredentials('tok-abc', 'bearer_token')).toEqual({ bearerToken: 'tok-abc' });
  });
});

describe('applyCreateOverrides', () => {
  it('overrides baseUrl, authType, and endpoint path for an unlocked definition', () => {
    const def = baseDefinition();
    const result = applyCreateOverrides(def, {
      baseUrl: 'https://override.test',
      configJson: { authType: 'bearer_token', endpointPath: '/v2/spend' },
    });
    expect(result.baseUrl).toBe('https://override.test');
    expect(result.authType).toBe('bearer_token');
    expect(result.endpoints[0].path).toBe('/v2/spend');
  });

  it('creates a GET endpoint when the definition had none', () => {
    const def = baseDefinition({ endpoints: [] });
    const result = applyCreateOverrides(def, { configJson: { endpointPath: '/v1/new' } });
    expect(result.endpoints).toEqual([{ path: '/v1/new', method: 'GET' }]);
  });

  it('does not let a locked built-in preset override baseUrl, auth, or endpoints', () => {
    const def = baseDefinition({ id: 'anthropic-usage', baseUrl: 'https://api.anthropic.com' });
    const result = applyCreateOverrides(def, {
      baseUrl: 'https://evil.test',
      configJson: { authType: 'bearer_token', endpointPath: '/hacked' },
    });
    expect(result.baseUrl).toBe('https://api.anthropic.com');
    expect(result.authType).toBe(def.authType);
    expect(result.endpoints[0].path).toBe('/v1/usage');
  });

  it('defaults the api-key header name when auth resolves to api_key_header', () => {
    const def = baseDefinition({ authHeaderName: undefined });
    const result = applyCreateOverrides(def, { configJson: {} });
    expect(result.authHeaderName).toBe('x-api-key');
  });
});

describe('resolveStoredDefinition', () => {
  it('returns undefined when the config carries no stored definition', () => {
    expect(resolveStoredDefinition({})).toBeUndefined();
  });

  it('returns a copy of the stored definition, applying baseUrl and endpointPath overrides', () => {
    const stored = baseDefinition();
    const result = resolveStoredDefinition({
      definition: stored,
      baseUrl: 'https://stored-override.test',
      endpointPath: '/v3/usage',
    });
    expect(result).toBeDefined();
    expect(result?.baseUrl).toBe('https://stored-override.test');
    expect(result?.endpoints[0].path).toBe('/v3/usage');
    // Original stored definition is not mutated.
    expect(stored.baseUrl).toBe('https://api.acme.test');
    expect(stored.endpoints[0].path).toBe('/v1/usage');
  });
});

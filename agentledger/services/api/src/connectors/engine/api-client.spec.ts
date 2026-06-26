import { buildAuthHeaders, executeRequest, resetRateLimitClock, executeWithRetry } from './api-client';
import { ConnectorDefinition } from '../types/connector-definition';

const baseDef: ConnectorDefinition = {
  name: 'test',
  provider: 'test',
  category: 'custom',
  authType: 'none',
  baseUrl: 'https://api.example.com',
  endpoints: [{ path: '/data', method: 'GET' }],
  fieldMappings: [],
  destinationRecordType: 'spend_usage_record',
};

describe('api-client auth headers', () => {
  it('builds api key header auth', async () => {
    const def = { ...baseDef, authType: 'api_key_header' as const, authHeaderName: 'x-api-key' };
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ data: [] }),
    });
    resetRateLimitClock();
    await executeRequest(def, { apiKey: 'key-123' }, {
      tenant_id: 't1', connector_id: 'c1', sync_start: '', sync_end: '', now: '',
    });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('key-123');
  });

  it('builds bearer token auth', async () => {
    const def = { ...baseDef, authType: 'bearer_token' as const };
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ data: [] }),
    });
    resetRateLimitClock();
    await executeRequest(def, { bearerToken: 'tok-abc' }, {
      tenant_id: 't1', connector_id: 'c1', sync_start: '', sync_end: '', now: '',
    });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer tok-abc');
  });

  it('builds custom header auth', () => {
    const headers = buildAuthHeaders('custom_header', { customHeader: { name: 'X-Custom', value: 'val' } });
    expect(headers['X-Custom']).toBe('val');
  });

  it('encodes array-style query param keys', async () => {
    const def: ConnectorDefinition = {
      ...baseDef,
      endpoints: [{
        path: '/cost_report',
        method: 'GET',
        queryParams: { 'group_by[]': 'model', limit: '7' },
      }],
    };
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ data: [] }),
    });
    resetRateLimitClock();
    await executeRequest(def, {}, {
      tenant_id: 't1', connector_id: 'c1', sync_start: '', sync_end: '', now: '',
    });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(call[0])).toContain('group_by%5B%5D=model');
  });
});

describe('api-client error handling', () => {
  it('throws on 401 auth failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: 'unauthorized' }),
    });
    resetRateLimitClock();
    await expect(
      executeWithRetry(baseDef, {}, { tenant_id: 't', connector_id: 'c', sync_start: '', sync_end: '', now: '' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('fails fast on 429 rate limit without retrying', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 429,
      headers: new Headers({ 'retry-after': '0' }),
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'too many' } }),
    });
    resetRateLimitClock();
    await expect(
      executeWithRetry(
        { ...baseDef, retry: { maxAttempts: 3, baseDelayMs: 1, retryOn: [429, 500] } },
        {},
        { tenant_id: 't', connector_id: 'c', sync_start: '', sync_end: '', now: '' },
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws on provider 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      headers: new Headers(),
      text: async () => 'internal error',
    });
    resetRateLimitClock();
    await expect(
      executeWithRetry(
        { ...baseDef, retry: { maxAttempts: 1 } },
        {},
        { tenant_id: 't', connector_id: 'c', sync_start: '', sync_end: '', now: '' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('extracts nested provider error messages', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 404,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          error: { type: 'not_found_error', message: 'usage endpoint not found' },
        }),
    });
    resetRateLimitClock();
    await expect(
      executeWithRetry(
        { ...baseDef, retry: { maxAttempts: 1 } },
        {},
        { tenant_id: 't', connector_id: 'c', sync_start: '', sync_end: '', now: '' },
      ),
    ).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      message: 'not_found_error: usage endpoint not found',
    });
  });
});

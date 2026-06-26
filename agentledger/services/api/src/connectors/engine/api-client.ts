import {
  ConnectorAuthType,
  ConnectorDefinition,
  ConnectorError,
  RateLimitConfig,
  RetryConfig,
  TemplateContext,
} from '../types/connector-definition';
import { safeErrorMessage } from './sanitizer';
import { renderObject, renderTemplate } from './template';

/** Extract a human-readable message from common provider error JSON shapes. */
export function extractProviderErrorMessage(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (typeof body !== 'object') return String(body);

  const obj = body as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.detail === 'string') return obj.detail;

  const error = obj.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (typeof err.message === 'string') {
      const type = typeof err.type === 'string' ? err.type : undefined;
      return type ? `${type}: ${err.message}` : err.message;
    }
  }

  return '';
}

export interface ApiCredentials {
  apiKey?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
  customHeader?: { name: string; value: string };
}

export interface ApiRequestResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function buildAuthHeaders(
  authType: ConnectorAuthType,
  creds: ApiCredentials,
  authHeaderName?: string,
): Record<string, string> {
  switch (authType) {
    case 'api_key_header':
      return { [authHeaderName ?? 'x-api-key']: creds.apiKey ?? '' };
    case 'bearer_token':
      return { Authorization: `Bearer ${creds.bearerToken ?? creds.apiKey ?? ''}` };
    case 'basic_auth': {
      const raw = `${creds.username ?? ''}:${creds.password ?? creds.apiKey ?? ''}`;
      return { Authorization: `Basic ${Buffer.from(raw).toString('base64')}` };
    }
    case 'custom_header':
      return creds.customHeader ? { [creds.customHeader.name]: creds.customHeader.value } : {};
    case 'none':
    default:
      return {};
  }
}

function classifyError(status: number, body: unknown): ConnectorError {
  const extracted = extractProviderErrorMessage(body);
  const msg = extracted || `HTTP ${status}`;

  const isRateLimited =
    status === 429 ||
    /rate.?limit/i.test(extracted) ||
    (body &&
      typeof body === 'object' &&
      (body as Record<string, unknown>).error &&
      typeof (body as Record<string, unknown>).error === 'object' &&
      (body as { error: { type?: string } }).error.type === 'rate_limit_error');

  if (isRateLimited) {
    return {
      code: 'RATE_LIMITED',
      message:
        extracted ||
        'Anthropic rate limit exceeded. Wait 60 seconds, then sync again (do not test and sync back-to-back).',
      statusCode: status,
      retryable: false,
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_FAILED',
      message: extracted || 'Authentication failed — check key type and permissions',
      statusCode: status,
      retryable: false,
    };
  }
  if (status >= 500) {
    return { code: 'PROVIDER_UNAVAILABLE', message: safeErrorMessage(msg), statusCode: status, retryable: true };
  }
  return { code: 'REQUEST_FAILED', message: safeErrorMessage(msg), statusCode: status, retryable: false };
}

async function applyRateLimit(cfg: RateLimitConfig | undefined): Promise<void> {
  if (!cfg) return;
  const minInterval =
    cfg.requestsPerSecond ? 1000 / cfg.requestsPerSecond
    : cfg.requestsPerMinute ? 60_000 / cfg.requestsPerMinute
    : 0;
  if (minInterval <= 0) return;
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < minInterval) await sleep(minInterval - elapsed);
  lastRequestAt = Date.now();
}

/** Reset rate limit clock between test runs. */
export function resetRateLimitClock(): void {
  lastRequestAt = 0;
}

function parseRetryAfterMs(headers: Record<string, string>): number {
  const raw = headers['retry-after'];
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return 0;
}

/** Execute a single HTTP request from a connector definition. */
export async function executeRequest(
  definition: ConnectorDefinition,
  creds: ApiCredentials,
  ctx: TemplateContext,
  overrides?: {
    path?: string;
    queryParams?: Record<string, string>;
    url?: string;
  },
): Promise<ApiRequestResult> {
  const endpoint = definition.endpoints[0];
  const method = endpoint?.method ?? definition.requestMethod ?? 'GET';
  const path = renderTemplate(overrides?.path ?? endpoint?.path ?? '/', ctx);
  const baseUrl = (definition.baseUrl ?? '').replace(/\/$/, '');
  const url = overrides?.url ?? `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const authHeaders = buildAuthHeaders(definition.authType, creds, definition.authHeaderName);
  const staticHeaders = renderObject(
    { ...definition.headers, ...endpoint?.headers },
    ctx,
  );
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...staticHeaders,
    ...authHeaders,
  };

  const query = new URLSearchParams({
    ...renderObject({ ...definition.queryParams, ...endpoint?.queryParams }, ctx),
    ...overrides?.queryParams,
  });
  const fullUrl = query.toString() ? `${url}?${query}` : url;

  let body: string | undefined;
  const bodyTpl = endpoint?.bodyTemplate ?? definition.bodyTemplate;
  if (bodyTpl && method !== 'GET') {
    body = renderTemplate(bodyTpl, ctx);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const res = await fetch(fullUrl, { method, headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 1000) };
  }

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });

  return { status: res.status, headers: resHeaders, body: parsed };
}

/** Execute with retry and rate limiting. */
export async function executeWithRetry(
  definition: ConnectorDefinition,
  creds: ApiCredentials,
  ctx: TemplateContext,
  overrides?: Parameters<typeof executeRequest>[3],
): Promise<ApiRequestResult> {
  const retry: RetryConfig = definition.retry ?? { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000, retryOn: [429, 500, 502, 503, 504] };
  const maxAttempts = retry.maxAttempts ?? 3;
  const retryOn = new Set(retry.retryOn ?? [429, 500, 502, 503, 504]);
  let lastErr: ConnectorError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await applyRateLimit(definition.rateLimit);
    const result = await executeRequest(definition, creds, ctx, overrides);

    if (result.status >= 200 && result.status < 300) {
      return result;
    }

    const err = classifyError(result.status, result.body);
    lastErr = err;

    if (result.status === 429 || !err.retryable || !retryOn.has(result.status) || attempt === maxAttempts) {
      throw err;
    }

    const retryAfter = parseRetryAfterMs(result.headers)
      || (definition.rateLimit?.retryAfterHeader
        ? Number(result.headers[definition.rateLimit.retryAfterHeader] ?? 0) * 1000
        : 0);
    const delay = retryAfter > 0
      ? retryAfter
      : Math.min((retry.baseDelayMs ?? 500) * 2 ** (attempt - 1), retry.maxDelayMs ?? 10_000);
    await sleep(delay);
  }

  throw lastErr ?? { code: 'REQUEST_FAILED', message: 'Request failed' };
}

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
];

const BLOCKED_CONTENT_FIELDS = [
  'prompt',
  'completion',
  'messages',
  'content',
  'input_text',
  'output_text',
  'raw_body',
];

const ALLOWLIST_HEADERS = new Set([
  'content-type',
  'date',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
]);

/** Redact secrets from arbitrary JSON for safe logging/preview. */
export function sanitizeForPreview(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 500) return `${value.slice(0, 200)}…[truncated]`;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeForPreview(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (BLOCKED_CONTENT_FIELDS.includes(k.toLowerCase())) {
        out[k] = '[redacted]';
        continue;
      }
      if (SECRET_PATTERNS.some((p) => p.test(k))) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitizeForPreview(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (!ALLOWLIST_HEADERS.has(lower)) continue;
    out[k] = SECRET_PATTERNS.some((p) => p.test(lower)) ? '[redacted]' : v;
  }
  return out;
}

/** Strip raw prompt/completion fields from a record before normalization. */
export function stripBlockedFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (BLOCKED_CONTENT_FIELDS.includes(k.toLowerCase())) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = stripBlockedFields(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Redact secrets from log-safe error messages. */
export function safeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[redacted]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, 'sk-[redacted]')
    .slice(0, 500);
}

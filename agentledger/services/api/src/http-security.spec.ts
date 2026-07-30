import {
  allowedCorsOrigins,
  corsOptions,
  EXTRA_CORS_ORIGINS,
  VALIDATION_PIPE_OPTIONS,
} from './http-security';

describe('http-security', () => {
  const prev = process.env.BADGERIQ_DASHBOARD_URL;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.BADGERIQ_DASHBOARD_URL;
    } else {
      process.env.BADGERIQ_DASHBOARD_URL = prev;
    }
  });

  it('ValidationPipe rejects unknown fields and enables implicit conversion', () => {
    expect(VALIDATION_PIPE_OPTIONS.whitelist).toBe(true);
    expect(VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted).toBe(true);
    expect(VALIDATION_PIPE_OPTIONS.transform).toBe(true);
    expect(VALIDATION_PIPE_OPTIONS.transformOptions?.enableImplicitConversion).toBe(true);
  });

  it('CORS defaults to local dashboard origin plus extra hosts, never wildcard', () => {
    delete process.env.BADGERIQ_DASHBOARD_URL;
    delete process.env.LEDGERAI_DASHBOARD_URL;
    delete process.env.AGENTLEDGER_DASHBOARD_URL;
    const opts = corsOptions();
    expect(opts.origin).toEqual([
      'http://localhost:3000',
      'https://badgeriq.studiodesigner.com',
      'https://d1e2lzkoizqhk6.cloudfront.net',
    ]);
    expect(opts.origin).not.toBe('*');
    expect(opts.credentials).toBe(true);
    expect(opts.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    );
    expect(opts.allowedHeaders).toEqual(
      expect.arrayContaining(['Authorization', 'Content-Type', 'x-tenant-id']),
    );
  });

  it('CORS whitelist includes BADGERIQ_DASHBOARD_URL and extra hosts', () => {
    process.env.BADGERIQ_DASHBOARD_URL = 'https://d1e2lzkoizqhk6.cloudfront.net';
    expect(allowedCorsOrigins()).toEqual([
      'https://d1e2lzkoizqhk6.cloudfront.net',
      'https://badgeriq.studiodesigner.com',
    ]);
    expect(corsOptions().origin).toEqual(allowedCorsOrigins());
    expect(EXTRA_CORS_ORIGINS).toContain('https://badgeriq.studiodesigner.com');
    expect(EXTRA_CORS_ORIGINS).toContain('https://d1e2lzkoizqhk6.cloudfront.net');
  });

  it('CORS whitelist dedupes when primary is already an extra host', () => {
    process.env.BADGERIQ_DASHBOARD_URL = 'https://badgeriq.studiodesigner.com';
    expect(allowedCorsOrigins()).toEqual([
      'https://badgeriq.studiodesigner.com',
      'https://d1e2lzkoizqhk6.cloudfront.net',
    ]);
  });
});

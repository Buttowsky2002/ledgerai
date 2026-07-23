import { corsOptions, VALIDATION_PIPE_OPTIONS } from './http-security';

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

  it('CORS defaults to local dashboard origin, never wildcard', () => {
    delete process.env.BADGERIQ_DASHBOARD_URL;
    delete process.env.LEDGERAI_DASHBOARD_URL;
    delete process.env.AGENTLEDGER_DASHBOARD_URL;
    const opts = corsOptions();
    expect(opts.origin).toBe('http://localhost:3000');
    expect(opts.origin).not.toBe('*');
    expect(opts.credentials).toBe(true);
    expect(opts.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    );
    expect(opts.allowedHeaders).toEqual(
      expect.arrayContaining(['Authorization', 'Content-Type', 'x-tenant-id']),
    );
  });

  it('CORS origin follows BADGERIQ_DASHBOARD_URL', () => {
    process.env.BADGERIQ_DASHBOARD_URL = 'https://d1e2lzkoizqhk6.cloudfront.net';
    expect(corsOptions().origin).toBe('https://d1e2lzkoizqhk6.cloudfront.net');
  });
});

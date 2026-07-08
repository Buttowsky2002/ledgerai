import { redactPgDsn, resolvePgDsn } from './env';

describe('resolvePgDsn', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('builds a Prisma-compatible Cloud SQL unix-socket DSN (localhost + trailing slash)', () => {
    delete process.env.BADGERIQ_PG_DSN;
    process.env.DB_HOST = '/cloudsql/badgeriq-prod:us-central1:badgeriq-db';
    process.env.DB_NAME = 'badgeriq_prod';
    process.env.DB_USER = 'badgeriq_app';
    process.env.DB_PASSWORD = 'secret';

    expect(resolvePgDsn()).toBe(
      'postgresql://badgeriq_app:secret@localhost/badgeriq_prod?host=/cloudsql/badgeriq-prod:us-central1:badgeriq-db/&connection_limit=20&pool_timeout=20',
    );
  });

  it('preserves a trailing slash on DB_HOST when already present', () => {
    delete process.env.BADGERIQ_PG_DSN;
    process.env.DB_HOST = '/cloudsql/proj:us-central1:db/';
    process.env.DB_NAME = 'badgeriq_prod';
    process.env.DB_USER = 'badgeriq_app';
    process.env.DB_PASSWORD = 'secret';

    expect(resolvePgDsn()).toBe(
      'postgresql://badgeriq_app:secret@localhost/badgeriq_prod?host=/cloudsql/proj:us-central1:db/&connection_limit=20&pool_timeout=20',
    );
  });

  it('trims whitespace from discrete env vars (common with Secret Manager)', () => {
    delete process.env.BADGERIQ_PG_DSN;
    process.env.DB_HOST = ' 10.0.0.5 ';
    process.env.DB_NAME = ' badgeriq_prod ';
    process.env.DB_USER = ' badgeriq_app ';
    process.env.DB_PASSWORD = ' secret\n';
    process.env.DB_PORT = '5432';
    process.env.DB_SSLMODE = 'require';

    expect(resolvePgDsn()).toBe(
      'postgresql://badgeriq_app:secret@10.0.0.5:5432/badgeriq_prod?sslmode=require&connection_limit=20&pool_timeout=20',
    );
  });

  it('prefers BADGERIQ_PG_DSN when set', () => {
    process.env.BADGERIQ_PG_DSN = 'postgresql://explicit:dsn@host/db';
    process.env.DB_HOST = '/cloudsql/ignored';
    expect(resolvePgDsn()).toBe('postgresql://explicit:dsn@host/db?connection_limit=20&pool_timeout=20');
  });

  it('does not override connection_limit when already present in BADGERIQ_PG_DSN', () => {
    process.env.BADGERIQ_PG_DSN = 'postgresql://u:p@host/db?connection_limit=8';
    expect(resolvePgDsn()).toBe('postgresql://u:p@host/db?connection_limit=8');
  });
});

describe('redactPgDsn', () => {
  it('redacts password from a DSN', () => {
    expect(
      redactPgDsn(
        'postgresql://badgeriq_app:secret@localhost/badgeriq_prod?host=/cloudsql/badgeriq-prod:us-central1:badgeriq-db/',
      ),
    ).toBe(
      'postgresql://badgeriq_app:***@localhost/badgeriq_prod?host=/cloudsql/badgeriq-prod:us-central1:badgeriq-db/',
    );
  });
});

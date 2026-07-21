/**
 * Environment-variable resolution with backwards-compatible aliasing.
 *
 * Prefer the `BADGERIQ_*` prefix. If unset, we fall back to the deprecated
 * `LEDGERAI_*` and legacy `AGENTLEDGER_*` aliases so existing deployments
 * keep working. See the "Renaming to BadgerIQ" note in the repo README.
 */
const ENV_PREFIXES = ['BADGERIQ_', 'LEDGERAI_', 'AGENTLEDGER_'] as const;

function envSuffix(name: string): string | null {
  for (const prefix of ENV_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return null;
}

export function env(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined && direct !== '') {
    return direct;
  }
  const suffix = envSuffix(name);
  if (!suffix) return direct;
  for (const prefix of ENV_PREFIXES) {
    const key = prefix + suffix;
    if (key === name) continue;
    const val = process.env[key];
    if (val !== undefined && val !== '') {
      return val;
    }
  }
  return direct;
}

/** Append Prisma pool sizing unless the DSN already sets connection_limit. */
export function appendPrismaPoolParams(dsn: string): string {
  if (/connection_limit=/i.test(dsn)) return dsn;
  const limit = env('BADGERIQ_PG_CONNECTION_LIMIT') ?? '20';
  const timeout = env('BADGERIQ_PG_POOL_TIMEOUT') ?? '20';
  const sep = dsn.includes('?') ? '&' : '?';
  return `${dsn}${sep}connection_limit=${limit}&pool_timeout=${timeout}`;
}

/**
 * Resolve the Postgres connection string. `BADGERIQ_PG_DSN` (and its aliases)
 * wins; otherwise the DSN is assembled from the discrete Cloud Run-style
 * variables DB_HOST / DB_NAME / DB_USER / DB_PASSWORD (+ optional DB_PORT,
 * DB_SSLMODE). A DB_HOST beginning with `/` is treated as a unix socket
 * directory (Cloud SQL: `/cloudsql/<project>:<region>:<instance>`).
 *
 * Pool params (`connection_limit`, `pool_timeout`) are appended when absent —
 * override via BADGERIQ_PG_CONNECTION_LIMIT / BADGERIQ_PG_POOL_TIMEOUT or embed
 * them directly in BADGERIQ_PG_DSN.
 */
export function resolvePgDsn(): string | undefined {
  const explicit = env('BADGERIQ_PG_DSN');
  if (explicit) return appendPrismaPoolParams(explicit);

  const host = process.env.DB_HOST?.trim();
  const name = process.env.DB_NAME?.trim();
  if (!host || !name) return undefined;

  const user = encodeURIComponent((process.env.DB_USER ?? 'postgres').trim());
  const password = encodeURIComponent((process.env.DB_PASSWORD ?? '').trim());
  const auth = password ? `${user}:${password}` : user;
  const db = encodeURIComponent(name);

  let dsn: string;
  if (host.startsWith('/')) {
    // Cloud SQL unix socket on Cloud Run (requires the cloudsql-instances
    // annotation). Prisma requires a dummy `localhost` host in the URL and the
    // real socket directory in the `host` query param — see Prisma's "connecting
    // via sockets" docs. A trailing slash on the socket path avoids Prisma/pg
    // appending `:5432` to the directory (`/cloudsql/...:5432`).
    const socketDir = host.endsWith('/') ? host : `${host}/`;
    dsn = `postgresql://${auth}@localhost/${db}?host=${socketDir}`;
  } else {
    const port = (process.env.DB_PORT ?? '5432').trim();
    const sslmode = (process.env.DB_SSLMODE ?? 'require').trim();
    dsn = `postgresql://${auth}@${host}:${port}/${db}?sslmode=${sslmode}`;
  }
  return appendPrismaPoolParams(dsn);
}

/** Redact credentials from a DSN for safe startup logging. */
export function redactPgDsn(dsn: string): string {
  return dsn.replace(/\/\/([^:@/]+)(?::[^@/]*)?@/, '//$1:***@');
}

import { env } from '../env';

/** Parse BADGERIQ_JWT_ACCESS_TTL values like 15m, 8h, 7d into seconds. */
export function parseDurationSeconds(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) {
    return 8 * 3600;
  }
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return 8 * 3600;
  }
}

export function accessTtlEnv(): string {
  return env('BADGERIQ_JWT_ACCESS_TTL') ?? '8h';
}

export function accessTtlSeconds(): number {
  return parseDurationSeconds(accessTtlEnv());
}

export function accessCookieMaxAgeMs(): number {
  return accessTtlSeconds() * 1000;
}

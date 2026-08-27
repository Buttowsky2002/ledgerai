import { accessTtlSeconds, parseDurationSeconds } from './session-ttl';

describe('session-ttl', () => {
  it('parses minute, hour, and day suffixes', () => {
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('8h')).toBe(28_800);
    expect(parseDurationSeconds('7d')).toBe(604_800);
  });

  it('defaults unknown formats to 8 hours', () => {
    expect(parseDurationSeconds('nope')).toBe(28_800);
  });

  it('uses BADGERIQ_JWT_ACCESS_TTL when set', () => {
    process.env.BADGERIQ_JWT_ACCESS_TTL = '2h';
    expect(accessTtlSeconds()).toBe(7200);
    delete process.env.BADGERIQ_JWT_ACCESS_TTL;
  });
});

import { BadRequestException } from '@nestjs/common';
import { resolveSyncWindow } from './sync-range';

describe('resolveSyncWindow', () => {
  it('defaults to a 30-day inclusive window ending today', () => {
    const { syncStart, syncEnd } = resolveSyncWindow();
    const days = Math.round((syncEnd.getTime() - syncStart.getTime()) / 86_400_000) + 1;
    expect(days).toBe(30);
  });

  it('accepts explicit from/to days', () => {
    const { syncStart, syncEnd } = resolveSyncWindow('2026-05-01', '2026-05-07');
    expect(syncStart.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(syncEnd.toISOString().slice(0, 10)).toBe('2026-05-07');
  });

  it('rejects ranges over 31 days', () => {
    expect(() => resolveSyncWindow('2026-01-01', '2026-02-15')).toThrow(BadRequestException);
  });
});

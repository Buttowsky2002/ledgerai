import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_BACKFILL_DAYS,
  MAX_RANGE_DAYS,
  resolvePreviewWindow,
  resolveSyncChunks,
  resolveSyncWindow,
  rollingSyncWindow,
} from './sync-range';

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

describe('resolvePreviewWindow', () => {
  it('clips wide ranges to the most recent 31 days', () => {
    const { syncStart, syncEnd } = resolvePreviewWindow('2026-01-01', '2026-03-31');
    const days = Math.round((syncEnd.getTime() - syncStart.getTime()) / 86_400_000) + 1;
    expect(days).toBe(MAX_RANGE_DAYS);
    expect(syncEnd.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(syncStart.toISOString().slice(0, 10)).toBe('2026-03-01');
  });
});

describe('resolveSyncChunks', () => {
  it(`defaults to ${DEFAULT_BACKFILL_DAYS} days split into 31-day API windows`, () => {
    const chunks = resolveSyncChunks();
    expect(chunks.length).toBe(3);
    const totalDays = chunks.reduce((sum, c) => {
      return sum + Math.round((c.syncEnd.getTime() - c.syncStart.getTime()) / 86_400_000) + 1;
    }, 0);
    expect(totalDays).toBe(DEFAULT_BACKFILL_DAYS);
  });

  it('splits explicit 90-day ranges into three chunks', () => {
    const chunks = resolveSyncChunks('2026-01-01', '2026-03-31');
    expect(chunks).toHaveLength(3);
    expect(chunks[0].syncStart.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(chunks[chunks.length - 1].syncEnd.toISOString().slice(0, 10)).toBe('2026-03-31');
  });
});

describe('rollingSyncWindow', () => {
  it('returns a 31-day inclusive window ending today', () => {
    const { from, to } = rollingSyncWindow();
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    expect(days).toBe(MAX_RANGE_DAYS);
  });
});

import { chunkRowsByBindLimit, PG_MAX_BIND_VARS } from './postgres-analytics.store';

describe('chunkRowsByBindLimit', () => {
  it('returns a single chunk when under the bind ceiling', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }));
    expect(chunkRowsByBindLimit(rows, 20)).toEqual([rows]);
  });

  it('splits so each chunk stays under PG_MAX_BIND_VARS', () => {
    const cols = 20;
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
    const chunks = chunkRowsByBindLimit(rows, cols);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length * cols).toBeLessThanOrEqual(PG_MAX_BIND_VARS);
    }
    expect(chunks.flat()).toHaveLength(rows.length);
  });

  it('handles the Cursor-scale case that blew past 32767 binds', () => {
    // ~40k binds / ~15 cols ≈ 2700 rows in one INSERT (observed pilot failure).
    const cols = 15;
    const rows = Array.from({ length: 2700 }, (_, i) => ({ i }));
    const chunks = chunkRowsByBindLimit(rows, cols);
    expect(chunks.every((c) => c.length * cols <= PG_MAX_BIND_VARS)).toBe(true);
    expect(chunks.flatMap((c) => c.length).reduce((a, b) => a + b, 0)).toBe(2700);
  });
});

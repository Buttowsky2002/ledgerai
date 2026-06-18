export interface Page {
  limit: number;
  offset: number;
}

/** Parse ?limit/?offset query params: default 50, clamped to [1,100]; offset ≥ 0. */
export function parsePagination(limit?: string, offset?: string): Page {
  const l = Number.parseInt(limit ?? '', 10);
  const o = Number.parseInt(offset ?? '', 10);
  return {
    limit: Math.min(Math.max(Number.isFinite(l) ? l : 50, 1), 100),
    offset: Math.max(Number.isFinite(o) ? o : 0, 0),
  };
}

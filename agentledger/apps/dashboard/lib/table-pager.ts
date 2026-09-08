/** Shared page size for condensed user / member tables. */
export const USERS_PAGE_SIZE = 10;

export type PageSlice<T> = {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  fromIndex: number;
  toIndex: number;
};

/** 1-based page index; clamps to valid range. */
export function paginateItems<T>(
  items: T[],
  page: number,
  pageSize = USERS_PAGE_SIZE,
): PageSlice<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Number.isFinite(page) && page > 0 ? Math.min(Math.floor(page), pageCount) : 1;
  const start = (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return {
    items: items.slice(start, end),
    page: safePage,
    pageCount,
    total,
    fromIndex: total === 0 ? 0 : start + 1,
    toIndex: end,
  };
}

export function parsePageParam(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

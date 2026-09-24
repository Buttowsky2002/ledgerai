/** Shared page size for condensed user / member tables. */
export const USERS_PAGE_SIZE = 10;

export const PAGE_SIZE_OPTIONS = [5, 10, 'all'] as const;
export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

export type PageSlice<T> = {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  fromIndex: number;
  toIndex: number;
};

/** 1-based page index; clamps to valid range. pageSize Infinity = all. */
export function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number = USERS_PAGE_SIZE,
): PageSlice<T> {
  const total = items.length;
  const effectiveSize = !Number.isFinite(pageSize) || pageSize <= 0 ? Math.max(total, 1) : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / effectiveSize) || 1);
  const safePage = Number.isFinite(page) && page > 0 ? Math.min(Math.floor(page), pageCount) : 1;
  const start = (safePage - 1) * effectiveSize;
  const end = Math.min(start + effectiveSize, total);
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

/** Parse ?pageSize=5|10|all into a numeric size (Infinity for all). */
export function parsePageSizeParam(raw: string | string[] | undefined): {
  option: PageSizeOption;
  size: number;
} {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (v === '5') {
    return { option: 5, size: 5 };
  }
  if (v === 'all') {
    return { option: 'all', size: Number.POSITIVE_INFINITY };
  }
  return { option: 10, size: USERS_PAGE_SIZE };
}

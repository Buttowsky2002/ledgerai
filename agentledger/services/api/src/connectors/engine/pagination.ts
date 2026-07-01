import { PaginationConfig } from '../types/connector-definition';
import { getPath } from './path';

export interface PageResult {
  items: Record<string, unknown>[];
  nextCursor?: string;
  nextUrl?: string;
  nextPage?: number;
  nextOffset?: number;
  nextToken?: string;
  hasMore: boolean;
}

/** Extract items and pagination state from an API response page. */
export function extractPage(
  response: unknown,
  config: PaginationConfig | undefined,
): PageResult {
  const itemsPath = config?.itemsPath ?? 'data';
  const rawItems = getPath(response, itemsPath);

  let items: Record<string, unknown>[];
  if (Array.isArray(rawItems)) {
    items = rawItems.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
  } else if (Array.isArray(response)) {
    items = (response as unknown[]).filter(
      (x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x),
    );
  } else {
    items = [];
  }

  if (config?.flattenPath && items.length > 0) {
    const flat: Record<string, unknown>[] = [];
    for (const item of items) {
      const nested = getPath(item, config.flattenPath);
      if (!Array.isArray(nested) || nested.length === 0) continue;
      for (const row of nested) {
        if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
          flat.push({ ...item, ...(row as Record<string, unknown>) });
        }
      }
    }
    items = flat;
  }

  if (!config || config.type === 'none') {
    return { items, hasMore: false };
  }

  if (config.hasMorePath && config.type === 'page' && !config.tokenPath) {
    const flag = getPath(response, config.hasMorePath);
    const hasMore = flag === true || flag === 'true' || flag === 1;
    return { items, hasMore };
  }

  switch (config.type) {
    case 'cursor': {
      const nextCursor = config.cursorPath ? String(getPath(response, config.cursorPath) ?? '') : undefined;
      return { items, nextCursor: nextCursor || undefined, hasMore: !!nextCursor };
    }
    case 'next_url': {
      const nextUrl = config.nextUrlPath ? String(getPath(response, config.nextUrlPath) ?? '') : undefined;
      return { items, nextUrl: nextUrl || undefined, hasMore: !!nextUrl };
    }
    case 'response_token': {
      const nextToken = config.tokenPath ? String(getPath(response, config.tokenPath) ?? '') : undefined;
      let hasMore = !!nextToken;
      if (config.hasMorePath) {
        const flag = getPath(response, config.hasMorePath);
        hasMore = (flag === true || flag === 'true' || flag === 1) && !!nextToken;
      }
      return { items, nextToken: hasMore ? nextToken : undefined, hasMore };
    }
    case 'page':
    case 'offset':
      return { items, hasMore: items.length >= (config.pageSize ?? 100) };
    default:
      return { items, hasMore: false };
  }
}

/** Build query params for the next pagination request. */
export function buildPaginationParams(
  config: PaginationConfig,
  state: { cursor?: string; page?: number; offset?: number; token?: string },
  pageSize: number,
): Record<string, string> {
  const params: Record<string, string> = {};
  switch (config.type) {
    case 'cursor':
      if (state.cursor && config.cursorParam) params[config.cursorParam] = state.cursor;
      break;
    case 'page':
      if (config.pageParam) params[config.pageParam] = String(state.page ?? 1);
      break;
    case 'offset':
      if (config.offsetParam) params[config.offsetParam] = String(state.offset ?? 0);
      break;
    case 'response_token':
      if (state.token && config.tokenParam) params[config.tokenParam] = state.token;
      break;
  }
  if (config.limitParam) params[config.limitParam] = String(pageSize);
  return params;
}

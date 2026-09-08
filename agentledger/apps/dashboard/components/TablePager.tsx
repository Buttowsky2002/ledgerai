'use client';

import Link from 'next/link';
import { USERS_PAGE_SIZE, type PageSlice } from '@/lib/table-pager';

type Props = {
  slice: Pick<PageSlice<unknown>, 'page' | 'pageCount' | 'total' | 'fromIndex' | 'toIndex'>;
  /** Build href for a 1-based page (server-driven). */
  hrefForPage?: (page: number) => string;
  /** Client-driven page change (overview panels). */
  onPageChange?: (page: number) => void;
  label?: string;
  pageSize?: number;
};

/** Compact prev/next pager for condensed user tables (10 per page). */
export function TablePager({
  slice,
  hrefForPage,
  onPageChange,
  label = 'users',
  pageSize = USERS_PAGE_SIZE,
}: Props) {
  if (slice.total <= pageSize) {
    return slice.total > 0 ? (
      <p className="mt-3 text-xs text-muted">
        Showing {slice.total} {label}
      </p>
    ) : null;
  }

  const prevDisabled = slice.page <= 1;
  const nextDisabled = slice.page >= slice.pageCount;
  const summary = (
    <span className="text-xs text-muted">
      {slice.fromIndex}–{slice.toIndex} of {slice.total} {label} · page {slice.page}/
      {slice.pageCount}
    </span>
  );

  const btnClass = (disabled: boolean) =>
    `rounded-md border border-edge px-2.5 py-1 text-xs ${
      disabled ? 'cursor-not-allowed text-muted/50' : 'text-muted hover:bg-white/5 hover:text-white'
    }`;

  if (hrefForPage) {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {summary}
        <div className="flex items-center gap-2">
          {prevDisabled ? (
            <span className={btnClass(true)}>Previous</span>
          ) : (
            <Link href={hrefForPage(slice.page - 1)} className={btnClass(false)} scroll={false}>
              Previous
            </Link>
          )}
          {nextDisabled ? (
            <span className={btnClass(true)}>Next</span>
          ) : (
            <Link href={hrefForPage(slice.page + 1)} className={btnClass(false)} scroll={false}>
              Next
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      {summary}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={prevDisabled}
          onClick={() => onPageChange?.(slice.page - 1)}
          className={btnClass(prevDisabled)}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={nextDisabled}
          onClick={() => onPageChange?.(slice.page + 1)}
          className={btnClass(nextDisabled)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

import { paginateItems, parsePageParam, USERS_PAGE_SIZE } from '../lib/table-pager';

describe('table-pager', () => {
  it('pages items into chunks of 10', () => {
    const items = Array.from({ length: 25 }, (_, i) => i + 1);
    const p1 = paginateItems(items, 1);
    expect(p1.items).toHaveLength(USERS_PAGE_SIZE);
    expect(p1.pageCount).toBe(3);
    expect(p1.fromIndex).toBe(1);
    expect(p1.toIndex).toBe(10);

    const p3 = paginateItems(items, 3);
    expect(p3.items).toEqual([21, 22, 23, 24, 25]);
    expect(p3.fromIndex).toBe(21);
    expect(p3.toIndex).toBe(25);
  });

  it('clamps invalid page numbers', () => {
    expect(paginateItems([1, 2], 0).page).toBe(1);
    expect(paginateItems([1, 2], 99).page).toBe(1);
    expect(parsePageParam('3')).toBe(3);
    expect(parsePageParam(undefined)).toBe(1);
  });
});

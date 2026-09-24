import { paginateItems, parsePageSizeParam } from '../lib/table-pager';
import { userVendorTotal, type VendorSpendSlice } from '../lib/vendor-spend';

describe('parsePageSizeParam', () => {
  it('parses 5, 10, and all', () => {
    expect(parsePageSizeParam('5')).toEqual({ option: 5, size: 5 });
    expect(parsePageSizeParam('10').option).toBe(10);
    expect(parsePageSizeParam('all').option).toBe('all');
    expect(Number.isFinite(parsePageSizeParam('all').size)).toBe(false);
  });
});

describe('paginateItems pageSize all', () => {
  it('returns every item on one page', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const slice = paginateItems(items, 1, Number.POSITIVE_INFINITY);
    expect(slice.items).toHaveLength(23);
    expect(slice.pageCount).toBe(1);
  });
});

describe('filtered grand total', () => {
  it('sums only filtered users seat+overage', () => {
    const alice: Record<string, VendorSpendSlice> = {
      anthropic: { seat_usd: 30, overage_usd: 10, total_usd: 40 },
    };
    const bob: Record<string, VendorSpendSlice> = {
      cursor: { seat_usd: 40, overage_usd: 50, total_usd: 90 },
    };
    const users = [
      { vendor_spend: alice, team: 'Development' },
      { vendor_spend: bob, team: 'Sales' },
    ];
    const development = users.filter((u) => u.team === 'Development');
    const total = development.reduce((s, u) => s + userVendorTotal(u), 0);
    expect(total).toBe(40);
  });
});

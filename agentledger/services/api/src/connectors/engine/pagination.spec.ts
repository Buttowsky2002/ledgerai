import { extractPage, buildPaginationParams } from './pagination';

describe('pagination', () => {
  it('extracts cursor pagination', () => {
    const result = extractPage(
      { data: [{ id: '1' }], next_cursor: 'abc' },
      { type: 'cursor', itemsPath: 'data', cursorPath: 'next_cursor' },
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('abc');
    expect(result.hasMore).toBe(true);
  });

  it('extracts page pagination', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const result = extractPage({ data: items }, { type: 'page', itemsPath: 'data', pageSize: 100 });
    expect(result.hasMore).toBe(true);
  });

  it('extracts next URL pagination', () => {
    const result = extractPage(
      { data: [{ id: '1' }], links: { next: 'https://api.example.com/page2' } },
      { type: 'next_url', itemsPath: 'data', nextUrlPath: 'links.next' },
    );
    expect(result.nextUrl).toBe('https://api.example.com/page2');
  });

  it('builds page params', () => {
    const params = buildPaginationParams({ type: 'page', pageParam: 'page', limitParam: 'limit' }, { page: 2 }, 50);
    expect(params).toEqual({ page: '2', limit: '50' });
  });

  it('handles no pagination', () => {
    const result = extractPage([{ id: '1' }, { id: '2' }], { type: 'none' });
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('flattens nested result rows', () => {
    const result = extractPage(
      {
        data: [
          {
            starting_at: '2025-01-01T00:00:00Z',
            results: [{ model: 'claude-3', output_tokens: 10 }],
          },
        ],
      },
      { type: 'none', itemsPath: 'data', flattenPath: 'results' },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].model).toBe('claude-3');
    expect(result.items[0].starting_at).toBe('2025-01-01T00:00:00Z');
  });
});

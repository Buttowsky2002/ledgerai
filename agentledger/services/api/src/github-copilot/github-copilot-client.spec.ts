import { GitHubCopilotClient, GitHubCopilotApiError } from './github-copilot-client';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GitHubCopilotClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const client = () =>
    new GitHubCopilotClient({
      token: 'ghp_test_token',
      orgSlug: 'acme-corp',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

  it('validates token against org and copilot seats endpoints', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ login: 'acme-corp', name: 'Acme Corp' }))
      .mockResolvedValueOnce(jsonResponse({ seats: [], total_seats: 0 }));
    const result = await client().validateToken();
    expect(result.orgName).toBe('Acme Corp');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns permission hint on 403 for billing seats', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ login: 'acme-corp', name: 'Acme Corp' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Forbidden' }, 403));
    await expect(client().validateToken()).rejects.toMatchObject({
      status: 403,
      hint: expect.stringContaining('seat management'),
    });
  });

  it('returns permission hint on 403 for billing summary', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: 'Forbidden' }, 403),
    );
    await expect(client().fetchBilling()).rejects.toMatchObject({
      status: 403,
      hint: expect.stringContaining('seat management'),
    });
  });

  it('paginates seats', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          seats: [
            {
              assignee: { id: 1, login: 'alice' },
              plan_type: 'business',
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      );
    const seats = await client().fetchAllSeats();
    expect(seats).toHaveLength(1);
    expect(seats[0].githubLogin).toBe('alice');
    expect(seats[0].monthlySeatCost).toBe(19);
  });

  it('downloads metrics report from download_links NDJSON', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          download_links: ['https://signed.example/report.ndjson'],
          report_end_day: '2024-06-01',
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/x-ndjson' },
        json: async () => ({}),
        text: async () =>
          [
            '{"user_login":"alice","day":"2024-06-01","loc_added_sum":42,"user_initiated_interaction_count":5}',
          ].join('\n'),
      });
    const rows = await client().fetchUsers1DayUsage('2024-06-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].githubLogin).toBe('alice');
    expect(rows[0].linesAccepted).toBe(42);
    expect(rows[0].chatTurns).toBe(5);
  });

  it('downloads metrics report from signed URL (legacy download_url)', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ download_url: 'https://signed.example/report.json' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              day: '2024-06-01',
              login: 'alice',
              lines_accepted: 42,
              chat_turns: 5,
            },
          ],
          200,
          { 'content-type': 'application/json' },
        ),
      );
    const rows = await client().fetchUsers1DayUsage('2024-06-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].githubLogin).toBe('alice');
    expect(rows[0].linesAccepted).toBe(42);
    expect(rows[0].chatTurns).toBe(5);
  });

  it('throws on expired report URL', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ download_url: 'https://signed.example/expired.json' }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: 'gone' }, 403));
    await expect(client().fetchOrg28DayUsage()).rejects.toBeInstanceOf(GitHubCopilotApiError);
  });

  it('retries on rate limit', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        json: async () => ({ message: 'rate limit' }),
        text: async () => '',
      })
      .mockResolvedValueOnce(jsonResponse({ seat_breakdown: {} }));
    await client().fetchBilling();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('normalizes AI credit billing usage items', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        timePeriod: { year: 2024, month: 6 },
        usageItems: [
          {
            username: 'alice',
            date: '2024-06-01',
            grossQuantity: 1000,
            grossAmount: 10,
            discountAmount: 8,
            netAmount: 2,
            model: 'gpt-4o',
          },
        ],
      }),
    );
    const rows = await client().fetchAiCreditUsage({ year: 2024, month: 6 });
    expect(rows).toHaveLength(1);
    expect(rows[0].githubLogin).toBe('alice');
    expect(rows[0].netAmount).toBe(2);
    expect(rows[0].grossAmount).toBe(10);
  });

  it('returns billing permission hint on 403', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Forbidden' }, 403));
    await expect(client().fetchAiCreditUsage({ year: 2024, month: 6 })).rejects.toMatchObject({
      status: 403,
      hint: expect.stringContaining('Billing'),
    });
  });
});

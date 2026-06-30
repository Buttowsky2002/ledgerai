import { GitHubCopilotClient, GitHubCopilotApiError } from './github-copilot-client';

describe('GitHubCopilotClient token validation', () => {
  it('validates token against org and seats endpoint', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/orgs/acme')) {
        return { ok: true, status: 200, json: async () => ({ login: 'acme', name: 'Acme Corp' }) };
      }
      if (url.includes('/copilot/billing/seats')) {
        return { ok: true, status: 200, json: async () => ({ seats: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({ message: 'not found' }) };
    });
    const client = new GitHubCopilotClient({ token: 'ghp_test', orgSlug: 'acme', fetchFn: fetchFn as never });
    const result = await client.validateToken();
    expect(result.ok).toBe(true);
    expect(result.orgName).toBe('Acme Corp');
  });

  it('surfaces 403 permission hints', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/orgs/acme') && !url.includes('copilot')) {
        return { ok: true, status: 200, json: async () => ({ login: 'acme' }) };
      }
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: 'Forbidden' }),
        headers: { get: () => null },
      };
    });
    const client = new GitHubCopilotClient({ token: 'ghp_bad', orgSlug: 'acme', fetchFn: fetchFn as never });
    await expect(client.validateToken()).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});

describe('GitHubCopilotClient seats import', () => {
  it('paginates billed seats', async () => {
    let page = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/orgs/acme') && !url.includes('copilot')) {
        return { ok: true, status: 200, json: async () => ({ login: 'acme' }) };
      }
      if (url.includes('page=1')) {
        page = 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            seats: [{ assignee: { id: 1, login: 'alice' }, plan_type: 'business' }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ seats: [] }) };
    });
    const client = new GitHubCopilotClient({ token: 'ghp_test', orgSlug: 'acme', fetchFn: fetchFn as never });
    const seats = await client.fetchAllSeats();
    expect(page).toBe(1);
    expect(seats).toHaveLength(1);
    expect(seats[0].githubLogin).toBe('alice');
  });
});

describe('GitHubCopilotClient metrics reports', () => {
  it('downloads signed report URL as NDJSON', async () => {
    const meta = { download_url: 'https://signed.example/report.ndjson' };
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('users-1-day')) {
        return { ok: true, status: 200, json: async () => meta };
      }
      if (url.includes('signed.example')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '{"day":"2024-06-01","user_login":"alice","loc_added_sum":10,"premium_requests_sum":5}\n',
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const client = new GitHubCopilotClient({ token: 'ghp_test', orgSlug: 'acme', fetchFn: fetchFn as never });
    const rows = await client.fetchUsers1DayUsage('2024-06-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].githubLogin).toBe('alice');
    expect(rows[0].linesAccepted).toBe(10);
  });

  it('throws on expired signed URL', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('users-28-day')) {
        return { ok: true, status: 200, json: async () => ({ download_url: 'https://expired.example/r' }) };
      }
      return { ok: false, status: 403, text: async () => '', headers: { get: () => null } };
    });
    const client = new GitHubCopilotClient({ token: 'ghp_test', orgSlug: 'acme', fetchFn: fetchFn as never });
    await expect(client.fetchUsers28DayUsage()).rejects.toBeInstanceOf(GitHubCopilotApiError);
  });
});

describe('GitHubCopilotClient team mapping', () => {
  it('fetches team members', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('/teams/eng/members')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 1, login: 'alice' }],
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    });
    const client = new GitHubCopilotClient({ token: 'ghp_test', orgSlug: 'acme', fetchFn: fetchFn as never });
    const members = await client.fetchTeamMembers('eng');
    expect(members).toEqual([{ id: 1, login: 'alice' }]);
  });
});

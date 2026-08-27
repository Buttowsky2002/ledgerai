import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  adoPrOutcomeId,
  adoWorkItemOutcomeId,
  fetchAzureDevOpsOutcomes,
  listProjectRepos,
  parseAdoConfig,
} from './azure-devops-client';

const FIXTURES = join(__dirname, 'fixtures');

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

describe('parseAdoConfig', () => {
  it('requires organization and project', () => {
    expect(() => parseAdoConfig({})).toThrow(/organization/);
    expect(() => parseAdoConfig({ organization: 'o' })).toThrow(/project/);
  });

  it('defaults lookback to 30 and parses repos', () => {
    const cfg = parseAdoConfig({
      organization: 'Studio',
      project: 'FinOps',
      repos: 'a, b',
    });
    expect(cfg).toEqual({
      organization: 'Studio',
      project: 'FinOps',
      lookbackDays: 30,
      repos: ['a', 'b'],
    });
  });

  it('matches repos by id or name', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        value: [{ id: '1998A6AA-7340-4EAA-88A5-E58145982808', name: 'studio-app' }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const repos = await listProjectRepos(
      fetchImpl,
      { pat: 'x' },
      parseAdoConfig({
        organization: 'Studio',
        project: 'FinOps',
        repos: ['1998A6AA-7340-4EAA-88A5-E58145982808'],
      }),
    );
    expect(repos).toHaveLength(1);
    expect(repos[0]?.name).toBe('studio-app');
  });
});

describe('ADO outcome ids', () => {
  it('builds stable PR and work-item ids', () => {
    expect(adoPrOutcomeId('org', 'proj', 'repo', 42)).toBe(
      'azure_devops:org/proj/repo#42',
    );
    expect(adoWorkItemOutcomeId('org', 'proj', 1001)).toBe('azure_devops:org/proj#1001');
  });
});

describe('fetchAzureDevOpsOutcomes', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const cfg = parseAdoConfig({
    organization: 'Studio',
    project: 'FinOps',
    lookback_days: 30,
  });

  it('maps merged PRs and completed work items from ADO fixtures', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      let body: unknown;
      if (u.includes('/_apis/git/repositories') && !u.includes('pullrequests')) {
        body = loadJson('repos.json');
      } else if (u.includes('pullrequests')) {
        body = loadJson('pull-requests.json');
      } else if (u.includes('/wit/wiql') && init?.method === 'POST') {
        body = loadJson('wiql.json');
      } else if (u.includes('/wit/workitems')) {
        body = loadJson('work-items.json');
      } else {
        throw new Error(`unexpected URL: ${u}`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });

    const { rows, skippedRepos } = await fetchAzureDevOpsOutcomes(
      { pat: 'test-pat-not-real' },
      cfg,
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    );

    const prs = rows.filter((r) => r.outcome_type === 'pr_merged');
    const wis = rows.filter((r) => r.outcome_type === 'work_item_closed');
    expect(skippedRepos).toEqual([]);

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      outcome_id: 'azure_devops:Studio/FinOps/studio-app#42',
      source_system: 'azure_devops',
      user_email: 'dev@studiodesigner.com',
      attribution_confidence: 0,
    });
    expect(wis).toHaveLength(2);
    expect(wis.map((w) => w.outcome_id).sort()).toEqual([
      'azure_devops:Studio/FinOps#1001',
      'azure_devops:Studio/FinOps#1002',
    ]);
    expect(rows.every((r) => !('provider' in r))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/git/repositories/repo-guid-1/pullrequests'),
      expect.anything(),
    );
  });

  it('skips inaccessible repos but still imports work items', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/_apis/git/repositories') && !u.includes('pullrequests')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            value: [
              { id: 'bad-repo-id', name: 'ghost-repo' },
              { id: 'repo-guid-1', name: 'studio-app' },
            ],
          }),
          text: async () => '',
        } as Response;
      }
      if (u.includes('ghost-repo') || u.includes('bad-repo-id')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () =>
            'TF401019: The Git repository with name or identifier bad-repo-id does not exist',
        } as Response;
      }
      if (u.includes('pullrequests')) {
        return {
          ok: true,
          status: 200,
          json: async () => loadJson('pull-requests.json'),
          text: async () => '',
        } as Response;
      }
      if (u.includes('/wit/wiql') && init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => loadJson('wiql.json'),
          text: async () => '',
        } as Response;
      }
      if (u.includes('/wit/workitems')) {
        return {
          ok: true,
          status: 200,
          json: async () => loadJson('work-items.json'),
          text: async () => '',
        } as Response;
      }
      throw new Error(`unexpected URL: ${u}`);
    });

    const { rows, skippedRepos } = await fetchAzureDevOpsOutcomes(
      { pat: 'test-pat-not-real' },
      cfg,
      { fetchImpl: fetchImpl as unknown as typeof fetch, now },
    );

    expect(skippedRepos).toEqual(['ghost-repo (bad-repo-id)']);
    expect(rows.some((r) => r.outcome_type === 'work_item_closed')).toBe(true);
    expect(rows.some((r) => r.outcome_type === 'pr_merged')).toBe(true);
  });
});

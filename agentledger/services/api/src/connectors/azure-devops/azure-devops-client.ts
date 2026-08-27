/**
 * Azure DevOps REST helpers — work items (WIQL) + completed pull requests.
 * Auth: PAT via Basic (empty user + PAT) per Microsoft docs.
 */

export type AdoCredentials = { pat: string };

export type AdoConfig = {
  organization: string;
  project: string;
  lookbackDays: number;
  /** Optional repo names; empty = all repos in the project. */
  repos: string[];
};

export type AdoOutcomeFlatRow = {
  idempotency_key: string;
  timestamp: string;
  outcome_id: string;
  outcome_type: 'pr_merged' | 'work_item_closed';
  source_system: 'azure_devops';
  source: 'api';
  user_id: string;
  user_email?: string;
  /** Left at 0 until attribution matcher / ROI templates assign confidence. */
  attribution_confidence: number;
};

export type AdoFetchResult = {
  rows: AdoOutcomeFlatRow[];
  /** Repos skipped due to 404/403 — sync continues for other repos + work items. */
  skippedRepos: string[];
};

function isRepoAccessError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bAzure DevOps (404|403)\b/.test(msg) || /GitRepositoryNotFoundException|TF401019/i.test(msg);
}

function repoScopedPullRequestsUrl(org: string, project: string, repositoryId: string): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}/` +
    `${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`
  );
}

type FetchLike = typeof fetch;

const API_VERSION = '7.1';

function encodePat(pat: string): string {
  return Buffer.from(`:${pat}`).toString('base64');
}

export function parseAdoConfig(cfg: Record<string, unknown>): AdoConfig {
  const organization = String(cfg.organization ?? cfg.org ?? '').trim();
  const project = String(cfg.project ?? '').trim();
  if (!organization || !project) {
    throw new Error('Azure DevOps connector requires config.organization and config.project');
  }
  const lookbackRaw = Number(cfg.lookback_days ?? cfg.lookbackDays ?? 30);
  const lookbackDays = Number.isFinite(lookbackRaw) && lookbackRaw > 0 ? Math.floor(lookbackRaw) : 30;
  const reposRaw = cfg.repos;
  const repos = Array.isArray(reposRaw)
    ? reposRaw.map((r) => String(r).trim()).filter(Boolean)
    : typeof reposRaw === 'string' && reposRaw.trim()
      ? reposRaw.split(',').map((r) => r.trim()).filter(Boolean)
      : [];
  return { organization, project, lookbackDays, repos };
}

async function adoFetch(
  fetchImpl: FetchLike,
  creds: AdoCredentials,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${encodePat(creds.pat)}`,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Azure DevOps ${res.status}: ${body.slice(0, 400)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Azure DevOps request timed out after ${timeoutMs / 1000}s: ${url.slice(0, 120)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function lookbackIso(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString();
}

/** Stable outcome ids for idempotent re-sync. */
export function adoPrOutcomeId(org: string, project: string, repo: string, prId: number): string {
  return `azure_devops:${org}/${project}/${repo}#${prId}`;
}

export function adoWorkItemOutcomeId(org: string, project: string, workItemId: number): string {
  return `azure_devops:${org}/${project}#${workItemId}`;
}

type AdoRepo = { id: string; name: string };
type AdoPr = {
  pullRequestId: number;
  title?: string;
  status?: string;
  closedDate?: string;
  creationDate?: string;
  createdBy?: { uniqueName?: string; displayName?: string; descriptor?: string };
  repository?: { name?: string };
};
type AdoWiqlResult = { workItems?: Array<{ id: number }> };
type AdoWorkItem = {
  id: number;
  fields?: Record<string, unknown>;
};

export async function listProjectRepos(
  fetchImpl: FetchLike,
  creds: AdoCredentials,
  cfg: AdoConfig,
): Promise<AdoRepo[]> {
  const url =
    `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/` +
    `${encodeURIComponent(cfg.project)}/_apis/git/repositories?api-version=${API_VERSION}`;
  const data = (await adoFetch(fetchImpl, creds, url)) as { value?: AdoRepo[] };
  const all = data?.value ?? [];
  if (cfg.repos.length === 0) return all;
  const want = new Set(cfg.repos.map((r) => r.toLowerCase()));
  return all.filter((r) => want.has(r.name.toLowerCase()) || want.has(r.id.toLowerCase()));
}

export async function fetchMergedPullRequests(
  fetchImpl: FetchLike,
  creds: AdoCredentials,
  cfg: AdoConfig,
  now = new Date(),
): Promise<AdoFetchResult> {
  const repos = await listProjectRepos(fetchImpl, creds, cfg);
  const floor = new Date(lookbackIso(cfg.lookbackDays, now)).getTime();
  const rows: AdoOutcomeFlatRow[] = [];
  const skippedRepos: string[] = [];

  if (cfg.repos.length > 0 && repos.length === 0) {
    throw new Error(
      `Azure DevOps: none of the configured repos match ${cfg.organization}/${cfg.project}. ` +
        `Use repo names (or IDs) from Test connection — not project names.`,
    );
  }

  for (const repo of repos) {
    try {
      let skip = 0;
      const top = 100;
      for (;;) {
        const q = new URLSearchParams({
          'searchCriteria.status': 'completed',
          '$top': String(top),
          '$skip': String(skip),
          'api-version': API_VERSION,
        });
        const url = `${repoScopedPullRequestsUrl(cfg.organization, cfg.project, repo.id)}?${q.toString()}`;
        const data = (await adoFetch(fetchImpl, creds, url)) as { value?: AdoPr[]; count?: number };
        const page = data?.value ?? [];
        if (page.length === 0) break;

        for (const pr of page) {
          const closed = pr.closedDate ?? pr.creationDate;
          if (!closed) continue;
          const ts = new Date(closed);
          if (Number.isNaN(ts.getTime()) || ts.getTime() < floor) continue;
          const user =
            pr.createdBy?.uniqueName ??
            pr.createdBy?.displayName ??
            '';
          const outcomeId = adoPrOutcomeId(cfg.organization, cfg.project, repo.name, pr.pullRequestId);
          rows.push({
            idempotency_key: outcomeId,
            timestamp: ts.toISOString(),
            outcome_id: outcomeId,
            outcome_type: 'pr_merged',
            source_system: 'azure_devops',
            source: 'api',
            user_id: user,
            user_email: user.includes('@') ? user : undefined,
            attribution_confidence: 0,
          });
        }

        if (page.length < top) break;
        skip += top;
      }
    } catch (err) {
      if (isRepoAccessError(err)) {
        skippedRepos.push(`${repo.name} (${repo.id})`);
        continue;
      }
      throw err;
    }
  }

  return { rows, skippedRepos };
}

export async function fetchClosedWorkItems(
  fetchImpl: FetchLike,
  creds: AdoCredentials,
  cfg: AdoConfig,
  now = new Date(),
): Promise<AdoOutcomeFlatRow[]> {
  const since = lookbackIso(cfg.lookbackDays, now).slice(0, 10);
  const wiql = {
    query:
      `Select [System.Id] From WorkItems Where ` +
      `[System.TeamProject] = '${cfg.project.replace(/'/g, "''")}' ` +
      `And [System.State] In ('Done', 'Closed', 'Resolved', 'Completed') ` +
      `And [System.ChangedDate] >= '${since}' ` +
      `Order By [System.ChangedDate] Desc`,
  };
  const wiqlUrl =
    `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/` +
    `${encodeURIComponent(cfg.project)}/_apis/wit/wiql?api-version=${API_VERSION}`;
  const wiqlResult = (await adoFetch(fetchImpl, creds, wiqlUrl, {
    method: 'POST',
    body: JSON.stringify(wiql),
  })) as AdoWiqlResult;

  const ids = (wiqlResult.workItems ?? []).map((w) => w.id).filter((id) => id > 0);
  if (ids.length === 0) return [];

  const rows: AdoOutcomeFlatRow[] = [];
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const q = new URLSearchParams({
      ids: chunk.join(','),
      fields: 'System.Id,System.Title,System.ChangedDate,System.AssignedTo,System.State,System.WorkItemType',
      'api-version': API_VERSION,
    });
    const url =
      `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/_apis/wit/workitems?${q.toString()}`;
    const data = (await adoFetch(fetchImpl, creds, url)) as { value?: AdoWorkItem[] };
    for (const wi of data?.value ?? []) {
      const fields = wi.fields ?? {};
      const changed = String(fields['System.ChangedDate'] ?? '');
      const ts = new Date(changed);
      if (Number.isNaN(ts.getTime())) continue;
      const assigned = fields['System.AssignedTo'];
      let user = '';
      if (typeof assigned === 'string') user = assigned;
      else if (assigned && typeof assigned === 'object') {
        const a = assigned as { uniqueName?: string; displayName?: string };
        user = a.uniqueName ?? a.displayName ?? '';
      }
      const outcomeId = adoWorkItemOutcomeId(cfg.organization, cfg.project, wi.id);
      rows.push({
        idempotency_key: outcomeId,
        timestamp: ts.toISOString(),
        outcome_id: outcomeId,
        outcome_type: 'work_item_closed',
        source_system: 'azure_devops',
        source: 'api',
        user_id: user,
        user_email: user.includes('@') ? user : undefined,
        attribution_confidence: 0,
      });
    }
  }

  return rows;
}

export async function fetchAzureDevOpsOutcomes(
  creds: AdoCredentials,
  cfg: AdoConfig,
  opts?: { fetchImpl?: FetchLike; now?: Date },
): Promise<AdoFetchResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? new Date();
  const [prResult, workItems] = await Promise.all([
    fetchMergedPullRequests(fetchImpl, creds, cfg, now),
    fetchClosedWorkItems(fetchImpl, creds, cfg, now),
  ]);
  return {
    rows: [...prResult.rows, ...workItems],
    skippedRepos: prResult.skippedRepos,
  };
}

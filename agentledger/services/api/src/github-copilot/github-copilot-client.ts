import { CopilotMemberRow, CopilotSeatRow, CopilotUsageRow } from './github-copilot.types';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubCopilotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'GitHubCopilotApiError';
  }
}

export interface GitHubClientOptions {
  token: string;
  orgSlug: string;
  enterpriseSlug?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface GitHubClientContext {
  orgSlug: string;
  enterpriseSlug?: string;
  isEnterprise: boolean;
}

function permissionHint(status: number, path: string): string | undefined {
  if (status === 403) {
    if (path.includes('/copilot/billing/seats')) {
      return (
        'Token needs Organization permissions: Copilot seat management (read). ' +
        'For classic PATs, use manage_billing:copilot + read:org.'
      );
    }
    if (path.includes('/copilot/billing')) {
      return (
        'Token needs Copilot billing or seat management access. Fine-grained PATs: enable ' +
        '"Organization copilot seat management". Classic PATs: manage_billing:copilot + read:org.'
      );
    }
    if (path.includes('/copilot/metrics')) {
      return (
        'Token needs Organization permissions: Copilot metrics (read). ' +
        'Also confirm Copilot usage metrics is enabled for the org in GitHub settings.'
      );
    }
    if (path.includes('/members') || path.includes('/teams')) {
      return 'Token needs Organization permissions: Members (read) to list members and teams.';
    }
    return (
      'Insufficient GitHub token permissions. Fine-grained PAT: Members (read), ' +
      'Organization Copilot metrics (read), Organization Copilot seat management (read).'
    );
  }
  if (status === 404) {
    return 'Organization not found or Copilot Business is not enabled for this org.';
  }
  return undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseDateOnly(value: unknown): Date | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback = ''): string {
  return value != null ? String(value) : fallback;
}

function nestedLogin(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as Record<string, unknown>;
  if (typeof o.login === 'string') return o.login;
  if (o.assignee && typeof o.assignee === 'object') {
    const a = o.assignee as Record<string, unknown>;
    if (typeof a.login === 'string') return a.login;
  }
  return '';
}

function nestedId(obj: unknown): number {
  if (!obj || typeof obj !== 'object') return 0;
  const o = obj as Record<string, unknown>;
  if (typeof o.id === 'number') return o.id;
  if (o.assignee && typeof o.assignee === 'object') {
    const a = o.assignee as Record<string, unknown>;
    if (typeof a.id === 'number') return a.id;
  }
  return 0;
}

export class GitHubCopilotClient {
  private readonly token: string;
  private readonly orgSlug: string;
  private readonly enterpriseSlug?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.orgSlug = opts.orgSlug;
    this.enterpriseSlug = opts.enterpriseSlug;
    this.baseUrl = opts.baseUrl ?? GITHUB_API;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get context(): GitHubClientContext {
    return {
      orgSlug: this.orgSlug,
      enterpriseSlug: this.enterpriseSlug,
      isEnterprise: Boolean(this.enterpriseSlug),
    };
  }

  /** Validate token against org + Copilot seats (works with fine-grained PAT permissions). */
  async validateToken(): Promise<{ ok: true; orgName: string }> {
    const org = await this.request<{ login?: string; name?: string }>(
      'GET',
      `/orgs/${encodeURIComponent(this.orgSlug)}`,
    );
    // Fine-grained PATs expose seat data via /copilot/billing/seats, not always /copilot/billing.
    await this.request(
      'GET',
      `/orgs/${encodeURIComponent(this.orgSlug)}/copilot/billing/seats?per_page=1`,
    );
    return { ok: true, orgName: org.name ?? org.login ?? this.orgSlug };
  }

  async fetchBilling(): Promise<Record<string, unknown>> {
    return this.request('GET', `/orgs/${encodeURIComponent(this.orgSlug)}/copilot/billing`);
  }

  async fetchAllSeats(): Promise<CopilotSeatRow[]> {
    const seats: CopilotSeatRow[] = [];
    let page = 1;
    for (;;) {
      const batch = await this.request<{ seats?: unknown[]; total_seats?: number }>(
        'GET',
        `/orgs/${encodeURIComponent(this.orgSlug)}/copilot/billing/seats?per_page=100&page=${page}`,
      );
      const items = Array.isArray(batch.seats) ? batch.seats : Array.isArray(batch) ? batch : [];
      if (items.length === 0) break;
      for (const raw of items) {
        seats.push(this.normalizeSeat(raw));
      }
      if (items.length < 100) break;
      page += 1;
      if (page > 500) break;
    }
    return seats;
  }

  async fetchMembers(): Promise<{ id: number; login: string }[]> {
    const members: { id: number; login: string }[] = [];
    let page = 1;
    for (;;) {
      const batch = await this.request<{ id?: number; login?: string }[]>(
        'GET',
        `/orgs/${encodeURIComponent(this.orgSlug)}/members?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) {
        if (m.id && m.login) members.push({ id: m.id, login: m.login });
      }
      if (batch.length < 100) break;
      page += 1;
    }
    return members;
  }

  async fetchTeams(): Promise<{ slug: string; name: string }[]> {
    const teams: { slug: string; name: string }[] = [];
    let page = 1;
    for (;;) {
      const batch = await this.request<{ slug?: string; name?: string }[]>(
        'GET',
        `/orgs/${encodeURIComponent(this.orgSlug)}/teams?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const t of batch) {
        if (t.slug) teams.push({ slug: t.slug, name: t.name ?? t.slug });
      }
      if (batch.length < 100) break;
      page += 1;
    }
    return teams;
  }

  async fetchTeamMembers(teamSlug: string): Promise<{ id: number; login: string }[]> {
    const members: { id: number; login: string }[] = [];
    let page = 1;
    for (;;) {
      const batch = await this.request<{ id?: number; login?: string }[]>(
        'GET',
        `/orgs/${encodeURIComponent(this.orgSlug)}/teams/${encodeURIComponent(teamSlug)}/members?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) {
        if (m.id && m.login) members.push({ id: m.id, login: m.login });
      }
      if (batch.length < 100) break;
      page += 1;
    }
    return members;
  }

  async fetchMembersDetailed(): Promise<CopilotMemberRow[]> {
    const members: CopilotMemberRow[] = [];
    let page = 1;
    for (;;) {
      const batch = await this.request<
        { id?: number; login?: string; avatar_url?: string; site_admin?: boolean }[]
      >(
        'GET',
        `/orgs/${encodeURIComponent(this.orgSlug)}/members?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) {
        if (m.id && m.login) {
          members.push({
            githubUserId: m.id,
            githubLogin: m.login,
            avatarUrl: m.avatar_url,
            isOrgMember: true,
          });
        }
      }
      if (batch.length < 100) break;
      page += 1;
    }
    return members;
  }

  async fetchOrg28DayUsage(): Promise<CopilotUsageRow[]> {
    const path = this.metricsPath('organization-28-day/latest');
    return this.fetchMetricsReport(path);
  }

  async fetchUsers28DayUsage(): Promise<CopilotUsageRow[]> {
    const path = this.metricsPath('users-28-day/latest');
    return this.fetchMetricsReport(path);
  }

  async fetchUsers1DayUsage(day: string): Promise<CopilotUsageRow[]> {
    const path = `${this.metricsPath('users-1-day')}?day=${encodeURIComponent(day)}`;
    return this.fetchMetricsReport(path);
  }

  private metricsPath(report: string): string {
    if (this.enterpriseSlug) {
      return `/enterprises/${encodeURIComponent(this.enterpriseSlug)}/copilot/metrics/reports/${report}`;
    }
    return `/orgs/${encodeURIComponent(this.orgSlug)}/copilot/metrics/reports/${report}`;
  }

  private async fetchMetricsReport(path: string): Promise<CopilotUsageRow[]> {
    const meta = await this.request<Record<string, unknown>>('GET', path);
    if (!meta || Object.keys(meta).length === 0) return [];

    const defaultDay = str(
      meta.report_end_day ?? meta.report_day ?? meta.report_start_day,
    ).slice(0, 10);

    const links = extractDownloadLinks(meta);
    if (links.length > 0) {
      const rows: CopilotUsageRow[] = [];
      for (const url of links) {
        rows.push(...(await this.downloadReport(url, path, defaultDay || undefined)));
      }
      return rows;
    }

    if (Array.isArray(meta)) return this.normalizeUsageRows(meta, path, defaultDay);
    if (Array.isArray(meta.data)) return this.normalizeUsageRows(meta.data as unknown[], path, defaultDay);
    return [];
  }

  private async downloadReport(
    url: string,
    sourcePath: string,
    defaultDay?: string,
  ): Promise<CopilotUsageRow[]> {
    const resp = await this.fetchFn(url, {
      headers: { Accept: 'application/x-ndjson, application/json, text/csv, */*' },
    });
    if (resp.status === 403 || resp.status === 404) {
      throw new GitHubCopilotApiError(
        'Metrics report download link expired or forbidden',
        resp.status,
        'report_expired',
        'Re-run sync to fetch a fresh signed report URL.',
      );
    }
    if (!resp.ok) {
      throw new GitHubCopilotApiError(
        `Failed to download metrics report (${resp.status})`,
        resp.status,
        'report_download_failed',
      );
    }
    const text = await resp.text();
    if (!text.trim()) return [];

    const ndjson = this.parseNdjsonReport(text, sourcePath, defaultDay);
    if (ndjson.length > 0) return ndjson;

    if (text.trimStart().startsWith('[') || text.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) return this.normalizeUsageRows(parsed, sourcePath, defaultDay);
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          if (Array.isArray(obj.data)) {
            return this.normalizeUsageRows(obj.data as unknown[], sourcePath, defaultDay);
          }
          if (Array.isArray(obj.users)) {
            return this.normalizeUsageRows(obj.users as unknown[], sourcePath, defaultDay);
          }
        }
      } catch {
        // fall through
      }
    }
    return this.parseCsvReport(text, sourcePath);
  }

  private parseNdjsonReport(text: string, sourcePath: string, defaultDay?: string): CopilotUsageRow[] {
    const rows: CopilotUsageRow[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as unknown;
        if (Array.isArray(obj)) {
          rows.push(...this.normalizeUsageRows(obj, sourcePath, defaultDay));
          continue;
        }
        if (obj && typeof obj === 'object') {
          const rec = obj as Record<string, unknown>;
          if (defaultDay && !rec.day && !rec.date) rec.day = defaultDay;
          rows.push(this.normalizeUsageRecord(rec, sourcePath));
        }
      } catch {
        // skip malformed NDJSON lines
      }
    }
    return rows;
  }

  private parseCsvReport(csv: string, sourcePath: string): CopilotUsageRow[] {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''));
    const rows: CopilotUsageRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      const rec: Record<string, string> = {};
      headers.forEach((h, idx) => {
        rec[h] = cols[idx] ?? '';
      });
      rows.push(this.normalizeUsageRecord(rec, sourcePath));
    }
    return rows;
  }

  private normalizeSeat(raw: unknown): CopilotSeatRow {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const team = r.assigning_team as Record<string, unknown> | undefined;
    const login = nestedLogin(r);
    const userId = nestedId(r);
    const pending = r.pending_cancellation_date ?? r.pendingCancellationDate;
    return {
      orgSlug: this.orgSlug,
      githubUserId: userId,
      githubLogin: login,
      planType: str(r.plan_type ?? r.planType, 'business'),
      assigningTeamSlug: team?.slug ? str(team.slug) : undefined,
      seatCreatedAt: parseDate(r.created_at ?? r.seat_created_at),
      pendingCancellationDate: parseDateOnly(pending),
      lastActivityAt: parseDate(r.last_activity_at ?? r.last_activity_date),
      lastActivityEditor: str(r.last_activity_editor ?? r.lastActivityEditor) || undefined,
      isActive: pending == null,
      monthlySeatCost: 19,
      rawPayload: r as Record<string, unknown>,
    };
  }

  private normalizeUsageRows(
    items: unknown[],
    sourcePath: string,
    defaultDay?: string,
  ): CopilotUsageRow[] {
    return items
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const rec = item as Record<string, unknown>;
        if (defaultDay && !rec.day && !rec.date) rec.day = defaultDay;
        return this.normalizeUsageRecord(rec, sourcePath);
      });
  }

  private normalizeUsageRecord(r: Record<string, unknown>, sourcePath: string): CopilotUsageRow {
    const day =
      str(r.day ?? r.date ?? r.usage_date ?? r.report_start_day ?? r.reportStartDay).slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    const team = r.team as Record<string, unknown> | undefined;
    const pr = r.pull_requests as Record<string, unknown> | undefined;
    const breakdown = Array.isArray(r.breakdown) ? r.breakdown[0] : undefined;
    const breakdownRec =
      breakdown && typeof breakdown === 'object' ? (breakdown as Record<string, unknown>) : undefined;

    return {
      usageDate: day,
      githubLogin: str(r.user_login ?? r.login ?? r.github_login ?? nestedLogin(r)),
      teamSlug: str(r.team_slug ?? r.teamSlug ?? r.slug ?? team?.slug),
      editor: str(r.editor ?? r.ide ?? breakdownRec?.editor),
      language: str(r.language ?? r.lang ?? breakdownRec?.language),
      model: str(r.model ?? breakdownRec?.model),
      feature: str(r.feature ?? r.copilot_feature ?? breakdownRec?.feature),
      suggestionsCount: num(
        r.code_generation_activity_count ?? r.suggestions_count ?? r.total_suggestions ?? r.suggestions,
      ),
      acceptancesCount: num(
        r.code_acceptance_activity_count ?? r.acceptances_count ?? r.total_acceptances ?? r.acceptances,
      ),
      linesSuggested: num(
        r.loc_suggested_to_add_sum ?? r.lines_suggested ?? r.total_lines_suggested,
      ),
      linesAccepted: num(r.loc_added_sum ?? r.lines_accepted ?? r.total_lines_accepted),
      activeUsers: num(
        r.daily_active_users ?? r.monthly_active_users ?? r.active_users ?? r.total_active_users,
      ),
      engagedUsers: num(
        r.weekly_active_users ?? r.engaged_users ?? r.total_engaged_users,
      ),
      chatTurns: num(
        r.user_initiated_interaction_count ?? r.chat_turns ?? r.total_chat_turns ?? r.chat,
      ),
      prSummaryCount: num(
        pr?.total_copilot_suggestions ??
          pr?.total_suggestions ??
          r.pr_summary_count ??
          r.pr_summaries ??
          r.pull_request_summaries,
      ),
      aiCreditsUsed: num(
        r.premium_requests_sum ??
          r.premium_request_count ??
          r.ai_credits_used ??
          r.credits_used ??
          r.premium_requests,
      ),
      rawPayload: { ...r, _source: sourcePath },
    };
  }

  private async request<T>(method: string, path: string, attempt = 0): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const resp = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'agentledger-github-copilot-connector',
      },
    });
    if (resp.status === 429 && attempt < 5) {
      const retryAfter = Number(resp.headers.get('retry-after') ?? '2');
      await sleep((retryAfter + attempt) * 1000);
      return this.request<T>(method, path, attempt + 1);
    }
    if (resp.status === 204) return {} as T;
    if (!resp.ok) {
      let detail = '';
      try {
        const body = (await resp.json()) as { message?: string };
        detail = body.message ?? '';
      } catch {
        // ignore
      }
      const hint = permissionHint(resp.status, path);
      throw new GitHubCopilotApiError(
        detail || `GitHub API error ${resp.status}`,
        resp.status,
        resp.status === 403 ? 'forbidden' : resp.status === 404 ? 'not_found' : 'api_error',
        hint,
      );
    }
    return (await resp.json()) as T;
  }
}

function extractDownloadLinks(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.download_links)) {
    return meta.download_links.filter((u): u is string => typeof u === 'string' && u.length > 0);
  }
  const single =
    (typeof meta.download_url === 'string' && meta.download_url) ||
    (typeof meta.report_url === 'string' && meta.report_url) ||
    (typeof meta.url === 'string' && meta.url);
  return single ? [single] : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

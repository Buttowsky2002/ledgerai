import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './openapi';

export interface AgentLedgerClientOptions {
  /** Base URL of the control-plane API, e.g. http://localhost:8094 */
  baseUrl: string;
  /** Optional access token; attached as `Authorization: Bearer <token>`. */
  token?: string;
}

/**
 * A fully-typed client for the control-plane API, generated from its OpenAPI spec.
 * Paths, params, request bodies, and responses are checked against `openapi.ts`.
 *
 *   const api = createAgentLedgerClient({ baseUrl, token });
 *   const { data, error } = await api.GET('/v1/analytics/spend', {
 *     params: { query: { from: '2026-06-01', to: '2026-06-30' } },
 *   });
 */
export function createAgentLedgerClient(opts: AgentLedgerClientOptions): Client<paths> {
  return createClient<paths>({
    baseUrl: opts.baseUrl,
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
  });
}

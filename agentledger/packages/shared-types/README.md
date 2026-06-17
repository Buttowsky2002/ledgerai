# @agentledger/shared-types

Generated TypeScript types and a typed client for the AgentLedger control-plane API.
Consumed by the dashboard (and any other TS consumer) so request/response shapes stay in
lockstep with the API.

- `src/openapi.ts` — generated from `docs/api/openapi.json` (`openapi-typescript`).
- `src/events.ts` — generated from `schemas/events/llm_call.schema.json` (`json-schema-to-typescript`).
- `src/client.ts` — `createAgentLedgerClient({ baseUrl, token })`, a typed `openapi-fetch` client.

Generated files are committed; regenerate after the API or event schema changes:

```bash
# 1. refresh the spec from the API
cd ../../services/api && npm run generate:openapi
# 2. regenerate types + build
cd ../../packages/shared-types && npm run generate && npm run build
```

## Usage

```ts
import { createAgentLedgerClient } from '@agentledger/shared-types';

const api = createAgentLedgerClient({ baseUrl: 'http://localhost:8094', token });
const { data, error } = await api.GET('/v1/analytics/spend', {
  params: { query: { from: '2026-06-01', to: '2026-06-30' } },
});
```

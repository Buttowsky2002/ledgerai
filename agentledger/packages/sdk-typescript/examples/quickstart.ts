// Quickstart: trace an agent run end to end.
import { LedgerAI } from '../src/index';

const ledger = new LedgerAI({
  apiKey: process.env.LEDGERAI_KEY,
  baseUrl: process.env.LEDGERAI_URL, // e.g. http://localhost:8090
  tenantId: process.env.LEDGERAI_TENANT_ID ?? '00000000-0000-4000-8000-000000000001',
  failOpen: true,
});

async function main(): Promise<void> {
  await ledger.run({ agentId: 'support-bot', metadata: { release: 'demo' } }, async (run) => {
    await run.llmCall({ provider: 'openai', model: 'gpt-4o', inputTokens: 320, outputTokens: 140, costUsd: 0.0021, latencyMs: 540 });
    await run.toolCall({ tool: 'search_kb', latencyMs: 35 });
    await run.outcome({ type: 'ticket_resolved', sourceSystem: 'zendesk', ref: 'ZD-4812', valueUsd: 18.5, attributionConfidence: 0.9 });
  });

  // Flush buffered telemetry before the process exits (scripts / serverless).
  await ledger.shutdown();
}

void main();

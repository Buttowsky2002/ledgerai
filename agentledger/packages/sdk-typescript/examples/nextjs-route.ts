// Next.js App Router — app/api/agent/route.ts
// Reuse one client across invocations; flush before the response returns so
// serverless freezes don't drop telemetry.
import { LedgerAI } from '../src/index';

const ledger = new LedgerAI({ apiKey: process.env.BADGERIQ_KEY, baseUrl: process.env.BADGERIQ_URL });

export async function POST(req: Request): Promise<Response> {
  const { question } = (await req.json()) as { question: string };

  const answer = await ledger.run({ agentId: 'support-bot' }, async (run) => {
    // ... call your model here ...
    await run.llmCall({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 200, outputTokens: 90, costUsd: 0.0005 });
    return `answer to: ${question}`;
  });

  await ledger.flush(); // important on serverless
  return new Response(JSON.stringify({ answer }), { headers: { 'content-type': 'application/json' } });
}

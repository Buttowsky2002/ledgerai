// Vercel AI SDK — wrap a generateText call.
import { LedgerAI } from '../src/index';

// Stand-in for `import { generateText } from 'ai'` so this example compiles
// without the dependency. In your app, delete this and use the real import.
type GenResult = { text: string; usage: { promptTokens: number; completionTokens: number } };
declare function generateText(args: { model: unknown; prompt: string }): Promise<GenResult>;

const ledger = new LedgerAI({ apiKey: process.env.BADGERIQ_KEY, baseUrl: process.env.BADGERIQ_URL });

export async function summarize(model: unknown, prompt: string): Promise<string> {
  return ledger.run({ agentId: 'summarizer' }, async (run) => {
    const res = await generateText({ model, prompt }); // e.g. generateText({ model: openai('gpt-4o'), prompt })
    await run.llmCall({
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: res.usage.promptTokens,
      outputTokens: res.usage.completionTokens,
    });
    return res.text; // only token counts are recorded — never the prompt/response text
  });
}

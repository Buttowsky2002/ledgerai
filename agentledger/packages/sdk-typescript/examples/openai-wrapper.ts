// OpenAI SDK wrapper — instrument every chat completion (token counts + cost
// only; the prompt/response text never leaves your process).
import { LedgerAI } from '../src/index';

// Minimal shape of the OpenAI client, so this example compiles without the
// `openai` dependency. In your app, use the real `OpenAI` type.
interface OpenAILike {
  chat: {
    completions: {
      create(args: { model: string; messages: { role: string; content: string }[] }): Promise<{
        choices: { message: { content: string | null } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>;
    };
  };
}

export function instrumentOpenAI(openai: OpenAILike, ledger: LedgerAI, agentId: string) {
  return {
    async chat(model: string, messages: { role: string; content: string }[]): Promise<string> {
      return ledger.run({ agentId }, async (run) => {
        const start = Date.now();
        const res = await openai.chat.completions.create({ model, messages });
        await run.llmCall({
          provider: 'openai',
          model,
          inputTokens: res.usage?.prompt_tokens,
          outputTokens: res.usage?.completion_tokens,
          latencyMs: Date.now() - start,
        });
        return res.choices[0]?.message.content ?? '';
      });
    },
  };
}

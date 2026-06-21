import type { TokenUsage } from '../types.js';

export interface ResponseParseResult {
  summary: string;
  tokens?: TokenUsage;
}

export const openaiChatParser = {
  parse(json: unknown): ResponseParseResult {
    const obj = (json ?? null) as Record<string, unknown> | null;

    const choices = obj && Array.isArray(obj['choices']) ? obj['choices'] as unknown[] : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const message = choice && typeof choice['message'] === 'object' && choice['message'] !== null
      ? choice['message'] as Record<string, unknown>
      : undefined;
    const content = message && typeof message['content'] === 'string' ? message['content'] : '';
    const summary = content.trim();

    let tokens: TokenUsage | undefined;
    const usage = obj && typeof obj['usage'] === 'object' && obj['usage'] !== null
      ? obj['usage'] as Record<string, unknown>
      : undefined;
    if (usage) {
      const input = typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : undefined;
      const output = typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : undefined;
      const total = typeof usage['total_tokens'] === 'number' ? usage['total_tokens'] : undefined;
      const details = usage['completion_tokens_details'];
      const reasoning = details !== null && typeof details === 'object' && !Array.isArray(details)
        && typeof (details as Record<string, unknown>)['reasoning_tokens'] === 'number'
        ? (details as Record<string, number>)['reasoning_tokens']
        : undefined;
      if (input !== undefined || output !== undefined || total !== undefined || reasoning !== undefined) {
        tokens = { input, output, reasoning, total: total ?? ((input ?? 0) + (output ?? 0)) };
      }
    }

    return { summary, tokens };
  },
};

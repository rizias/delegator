import type { TokenUsage, WorkerEvent } from '../types.js';
import type { ParserPreset } from './registry.js';

export const claudeStreamJsonParser: ParserPreset = {
  parseLine(line: string, stream: 'stdout' | 'stderr'): WorkerEvent {
    const raw = line.length > 4000 ? line.slice(0, 4000) : line;

    if (stream === 'stderr') {
      const kind: WorkerEvent['kind'] =
        line.includes('Warning') || /^\s*$/.test(line) ? 'noise' : 'output';
      return { ts: Date.now(), stream, kind, raw };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ts: Date.now(), stream, kind: 'output', raw };
    }

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'type' in parsed
    ) {
      const obj = parsed as Record<string, unknown>;
      const type = obj['type'];

      if (type === 'assistant') {
        const nested = obj['parent_tool_use_id'] !== undefined && obj['parent_tool_use_id'] !== null;
        const text = extractAssistantText(obj);
        return { ts: Date.now(), stream, kind: nested ? 'output' : 'turn', raw, ...(text ? { text } : {}) };
      }

      if (type === 'result') {
        let tokens: TokenUsage | undefined;
        const usage = obj['usage'];
        if (
          usage !== null &&
          typeof usage === 'object' &&
          !Array.isArray(usage)
        ) {
          const u = usage as Record<string, unknown>;
          const inp = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : undefined;
          const out = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : undefined;
          const reasoning = reasoningFromClaudeUsage(u);
          if (inp !== undefined || out !== undefined || reasoning !== undefined) {
            tokens = {
              input: inp,
              output: out,
              reasoning,
              ...(inp !== undefined || out !== undefined ? { total: (inp ?? 0) + (out ?? 0) } : {}),
            };
          }
        }
        return { ts: Date.now(), stream, kind: 'result', raw, tokens };
      }

      if (type === 'system' || type === 'user') {
        return { ts: Date.now(), stream, kind: 'output', raw };
      }
    }

    return { ts: Date.now(), stream, kind: 'output', raw };
  },

  finalSummary(stdoutTail: string, events: WorkerEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === 'result') {
        try {
          const parsed = JSON.parse(events[i]!.raw) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            const r = obj['result'];
            if (typeof r === 'string' && r.trim() !== '') return r;
            if (obj['is_error'] === true) {
              const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : 'error';
              const errs = Array.isArray(obj['errors']) ? (obj['errors'] as unknown[]).map(String).join('; ') : '';
              const lastText = lastAssistantText(events);
              return `claude stopped: ${subtype}${errs ? ` (${errs})` : ''}${lastText ? `\nlast assistant message:\n${lastText}` : ''}`;
            }
          }
        } catch {
          // fall through to fallback
        }
        break;
      }
    }

    const assistant = lastAssistantText(events);
    if (assistant) return assistant;
    const lines = stdoutTail.split('\n');
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    return nonEmpty.slice(-30).join('\n');
  },

  finalUsage(events: WorkerEvent[]): { tokens?: TokenUsage; iterations?: number } {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === 'result') {
        try {
          const parsed = JSON.parse(events[i]!.raw) as unknown;
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed)
          ) {
            const obj = parsed as Record<string, unknown>;
            let tokens: TokenUsage | undefined;
            const usage = obj['usage'];
            if (
              usage !== null &&
              typeof usage === 'object' &&
              !Array.isArray(usage)
            ) {
              const u = usage as Record<string, unknown>;
              const inp = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : undefined;
              const out = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : undefined;
              const reasoning = reasoningFromClaudeUsage(u);
              if (inp !== undefined || out !== undefined || reasoning !== undefined) {
                tokens = {
                  input: inp,
                  output: out,
                  reasoning,
                  ...(inp !== undefined || out !== undefined ? { total: (inp ?? 0) + (out ?? 0) } : {}),
                };
              }
            }
            const numTurns = typeof obj['num_turns'] === 'number' ? obj['num_turns'] : undefined;
            return { tokens, iterations: numTurns };
          }
        } catch {
          // fall through
        }
        break;
      }
    }
    return {};
  },

};

export function extractAssistantText(obj: Record<string, unknown>): string | undefined {
  const message = obj['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((c): c is { type: string; text: string } =>
      c !== null && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
    .map((c) => c.text);
  return texts.length ? texts.join('\n') : undefined;
}

export function lastAssistantText(events: WorkerEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind !== 'turn') continue;
    const captured = events[i]!.text;
    if (captured) return captured.slice(0, 4000);
    try {
      const parsed = JSON.parse(events[i]!.raw) as Record<string, unknown>;
      const text = extractAssistantText(parsed);
      if (text) return text.slice(0, 4000);
    } catch {
      // keep scanning
    }
  }
  return '';
}

export function reasoningFromClaudeUsage(usage: Record<string, unknown>): number | undefined {
  for (const key of ['reasoning_tokens', 'thinking_tokens']) {
    const value = usage[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

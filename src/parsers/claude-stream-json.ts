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
        // A synthetic message (message.model === '<synthetic>') is injected LOCALLY by the claude
        // CLI — a permission/limit/interrupt notice with zero provider tokens, not a model turn and
        // not a provider verdict. Mark it 'noise' so it neither counts as a turn nor feeds failure
        // classification: a stray "unauthorized"/"forbidden" in that notice must not trip the auth breaker.
        const message = obj['message'] as Record<string, unknown> | undefined;
        const synthetic = message?.['model'] === '<synthetic>';
        const kind: WorkerEvent['kind'] = synthetic ? 'noise' : nested ? 'output' : 'turn';
        return {
          ts: Date.now(), stream, kind, raw,
          ...(synthetic ? { synthetic: true } : {}),
          ...(text ? { text } : {}),
        };
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
        // Capture the final answer and error diagnostics from the FULL line now — `raw` is
        // truncated for the log, so finalSummary must not re-parse it (see finalSummary/tokens).
        const rawResult = obj['result'];
        const resultText = typeof rawResult === 'string' ? rawResult : undefined;
        const isError = obj['is_error'] === true ? true : undefined;
        const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : undefined;
        const errors = Array.isArray(obj['errors']) ? (obj['errors'] as unknown[]).map(String) : undefined;
        const numTurns = typeof obj['num_turns'] === 'number' ? obj['num_turns'] : undefined;
        return {
          ts: Date.now(), stream, kind: 'result', raw, tokens,
          ...(resultText !== undefined ? { resultText } : {}),
          ...(isError !== undefined ? { isError } : {}),
          ...(subtype !== undefined ? { subtype } : {}),
          ...(errors !== undefined ? { errors } : {}),
          ...(numTurns !== undefined ? { iterations: numTurns } : {}),
        };
      }

      if (type === 'system' || type === 'user') {
        return { ts: Date.now(), stream, kind: 'output', raw };
      }
    }

    return { ts: Date.now(), stream, kind: 'output', raw };
  },

  finalSummary(stdoutTail: string, events: WorkerEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind === 'result') {
        // Read the fields captured at parse time from the FULL line — never re-parse `ev.raw`,
        // which is truncated to 4000 chars and is invalid JSON for a long answer.
        if (typeof ev.resultText === 'string' && ev.resultText.trim() !== '') return ev.resultText;
        if (ev.isError === true) {
          const subtype = ev.subtype ?? 'error';
          const errs = ev.errors && ev.errors.length ? ev.errors.join('; ') : '';
          const lastText = lastAssistantText(events);
          return `claude stopped: ${subtype}${errs ? ` (${errs})` : ''}${lastText ? `\nlast assistant message:\n${lastText}` : ''}`;
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
      const ev = events[i]!;
      if (ev.kind === 'result') {
        // Read the tokens and iteration count captured at parse time from the FULL line — never
        // re-parse ev.raw, which is truncated to 4000 chars (see parseLine / finalSummary).
        return { tokens: ev.tokens, iterations: ev.iterations };
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
  // No real turn: a synthetic notice (excluded from turns and classification) may still be
  // the only human-readable explanation of why claude stopped — surface it in the summary.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.synthetic && ev.text) return ev.text.slice(0, 4000);
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

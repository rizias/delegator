import type { TokenUsage, WorkerEvent } from '../types.js';
import type { ParserPreset } from './registry.js';

export const piNdjsonParser: ParserPreset = {
  parseLine(line: string, stream: 'stdout' | 'stderr'): WorkerEvent {
    const raw = line.length > 4000 ? line.slice(0, 4000) : line;
    if (stream === 'stderr') {
      return { ts: Date.now(), stream, kind: /^\s*$/.test(line) ? 'noise' : 'output', raw };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ts: Date.now(), stream, kind: 'output', raw };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ts: Date.now(), stream, kind: 'output', raw };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === 'turn_start') return { ts: Date.now(), stream, kind: 'turn', raw };
    if (obj.type === 'message_end' && assistantRole(obj)) {
      const text = assistantText(obj);
      const tokens = usageFromObject(obj);
      return {
        ts: Date.now(),
        stream,
        kind: 'result',
        raw,
        ...(text ? { text } : {}),
        ...(tokens ? { tokens } : {}),
      };
    }
    return { ts: Date.now(), stream, kind: 'output', raw };
  },

  finalSummary(stdoutTail: string, events: WorkerEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind === 'result' && ev.text) return ev.text;
      if (ev.kind !== 'result') continue;
      const text = textFromRaw(ev.raw);
      if (text) return text;
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const text = textFromRaw(events[i]!.raw, 'agent_end');
      if (text) return text;
    }
    const lines = stdoutTail.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-30).join('\n');
  },

  finalUsage(events: WorkerEvent[]): { tokens?: TokenUsage; iterations?: number } {
    let tokens: TokenUsage | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      tokens = events[i]!.tokens ?? usageFromRaw(events[i]!.raw);
      if (tokens) break;
    }
    const iterations = events.filter((ev) => {
      if (ev.kind !== 'turn') return false;
      try {
        const parsed = JSON.parse(ev.raw) as Record<string, unknown>;
        return parsed.type === 'turn_start';
      } catch {
        return false;
      }
    }).length;
    return {
      tokens,
      ...(iterations > 0 ? { iterations } : {}),
    };
  },
};

export function assistantRole(obj: Record<string, unknown>): boolean {
  const message = obj.message;
  return message !== null &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).role === 'assistant';
}

export function assistantText(obj: Record<string, unknown>): string {
  const message = obj.message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return '';
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } =>
      part !== null &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      (part as Record<string, unknown>).type === 'text' &&
      typeof (part as Record<string, unknown>).text === 'string')
    .map((part) => part.text)
    .join('');
}

export function usageFromObject(obj: Record<string, unknown>): TokenUsage | undefined {
  const message = obj.message;
  const messageUsage = message !== null && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>).usage
    : undefined;
  const usage = messageUsage ?? obj.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input === 'number' ? u.input : undefined;
  const output = typeof u.output === 'number' ? u.output : undefined;
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : undefined;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, total };
}

export function usageFromRaw(raw: string): TokenUsage | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'message_end' && obj.type !== 'turn_end' && obj.type !== 'agent_end') return undefined;
    if (obj.type === 'message_end' && !assistantRole(obj)) return undefined;
    return usageFromObject(obj);
  } catch {
    return undefined;
  }
}

export function textFromRaw(raw: string, type?: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const obj = parsed as Record<string, unknown>;
    if (type !== undefined && obj.type !== type) return '';
    if (type === undefined && obj.type !== 'message_end') return '';
    return assistantRole(obj) ? assistantText(obj) : '';
  } catch {
    return '';
  }
}

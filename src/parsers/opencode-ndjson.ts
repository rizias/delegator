import type { TokenUsage, WorkerEvent } from '../types.js';
import type { ParserPreset } from './registry.js';

export const opencodeNdjsonParser: ParserPreset = {
  parseLine(line: string, stream: 'stdout' | 'stderr'): WorkerEvent {
    const raw = line.length > 4000 ? line.slice(0, 4000) : line;

    if (stream === 'stderr') {
      const kind: WorkerEvent['kind'] =
        raw.includes('�') || /^\s*$/.test(line) || line.includes('\x1b[')
          ? 'noise'
          : 'output';
      return { ts: Date.now(), stream, kind, raw };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ts: Date.now(), stream, kind: 'output', raw };
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { ts: Date.now(), stream, kind: 'output', raw };
    }
    const obj = parsed as Record<string, unknown>;
    const type = obj['type'];
    const part = (obj['part'] ?? null) as Record<string, unknown> | null;
    const partType = part && typeof part['type'] === 'string' ? part['type'] : '';

    if (type === 'error') {
      return { ts: Date.now(), stream, kind: 'error', raw };
    }

    if (type === 'step_start' || partType === 'step-start') {
      return { ts: Date.now(), stream, kind: 'turn', raw };
    }
    if (type === 'step_finish' || partType === 'step-finish') {
      return { ts: Date.now(), stream, kind: 'usage', raw, tokens: tokensFromStepFinish(part) };
    }
    if (partType === 'text') {
      // Capture the text from the FULL parsed part now — `raw` is truncated to 4000 chars below,
      // and finalSummary must not re-parse a clipped line or a long final message is lost.
      const text = part && typeof part['text'] === 'string' ? part['text'] : undefined;
      return { ts: Date.now(), stream, kind: 'output', raw, ...(text ? { text } : {}) };
    }
    return { ts: Date.now(), stream, kind: 'output', raw };
  },

  finalSummary(stdoutTail: string, events: WorkerEvent[]): string {
    const texts: string[] = [];
    for (const ev of events) {
      if (ev.stream !== 'stdout') continue;
      // Use ev.text (captured from the FULL line at parse time). Re-parsing the truncated ev.raw
      // (textPartOf) drops a long final message — the same truncation bug fixed for codex.
      if (ev.text) texts.push(ev.text);
    }
    const msg = texts.join('').trim();
    if (msg.length > 0) return msg;

    const lastTool = lastToolSummary(events);
    if (lastTool) return lastTool;

    const lines = stdoutTail.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-30).join('\n');
  },

  finalUsage(events: WorkerEvent[]): { tokens?: TokenUsage; iterations?: number } {
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let total = 0;
    let steps = 0;
    let saw = false;
    let sawReasoning = false;
    for (const ev of events) {
      if (ev.kind !== 'usage') continue;
      steps += 1;
      if (ev.tokens) {
        saw = true;
        input += ev.tokens.input ?? 0;
        output += ev.tokens.output ?? 0;
        if (ev.tokens.reasoning !== undefined) {
          sawReasoning = true;
          reasoning += ev.tokens.reasoning;
        }
        total += ev.tokens.total ?? 0;
      }
    }
    return {
      tokens: saw ? { input, output, ...(sawReasoning ? { reasoning } : {}), total } : undefined,
      iterations: steps > 0 ? steps : undefined,
    };
  },
};

export function tokensFromStepFinish(part: Record<string, unknown> | null): TokenUsage | undefined {
  if (!part) return undefined;
  const tk = part['tokens'];
  if (tk === null || typeof tk !== 'object' || Array.isArray(tk)) return undefined;
  const t = tk as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(t['input']);
  const out = num(t['output']);
  const reasoning = num(t['reasoning']);
  if (input === undefined && out === undefined && reasoning === undefined) return undefined;
  return {
    input,
    output: out,
    reasoning,
    total: (input ?? 0) + (out ?? 0) + (reasoning ?? 0),
  };
}

export function textPartOf(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object') return '';
  const part = (parsed as Record<string, unknown>)['part'];
  if (part === null || typeof part !== 'object' || Array.isArray(part)) return '';
  const p = part as Record<string, unknown>;
  if (p['type'] !== 'text') return '';
  return typeof p['text'] === 'string' ? p['text'] : '';
}

export function lastToolSummary(events: WorkerEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.stream !== 'stdout') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const part = (parsed as Record<string, unknown>)['part'];
    if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
    const p = part as Record<string, unknown>;
    if (p['type'] !== 'tool') continue;
    const tool = typeof p['tool'] === 'string' ? p['tool'] : 'tool';
    const state = (p['state'] ?? null) as Record<string, unknown> | null;
    const status = state && typeof state['status'] === 'string' ? state['status'] : '';
    const out = state && typeof state['output'] === 'string' ? state['output'] : '';
    const msg = `worker emitted no final message; last action: ${tool}${status ? ` (${status})` : ''}${out ? ` — ${out}` : ''}`;
    return msg.length > 500 ? msg.slice(0, 500) : msg;
  }
  return '';
}

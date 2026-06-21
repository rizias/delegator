import path from 'node:path';
import type { TokenUsage, WorkerEvent } from '../types.js';
import type { ParserPreset } from './registry.js';

const TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'todo_list',
]);

export const codexExecJsonParser: ParserPreset = {
  parseLine(line: string, stream: 'stdout' | 'stderr'): WorkerEvent {
    const raw = line.length > 4000 ? line.slice(0, 4000) : line;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const kind: WorkerEvent['kind'] = stream === 'stderr' && /^\s*$/.test(line) ? 'noise' : 'output';
      return { ts: Date.now(), stream, kind, raw };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ts: Date.now(), stream, kind: 'output', raw };
    }

    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : '';

    if (type === 'thread.started') {
      const threadId = typeof obj.thread_id === 'string' ? obj.thread_id : undefined;
      return { ts: Date.now(), stream, kind: 'noise', raw, ...(threadId ? { text: threadId } : {}) };
    }

    if (type === 'turn.started') {
      return { ts: Date.now(), stream, kind: 'noise', raw };
    }

    if (type === 'turn.completed') {
      return { ts: Date.now(), stream, kind: 'turn', raw, tokens: usageFromTurnCompleted(obj) };
    }

    if (type === 'turn.failed') {
      return { ts: Date.now(), stream, kind: 'error', raw, text: errorText(obj) };
    }

    if (type === 'error') {
      return { ts: Date.now(), stream, kind: 'error', raw, text: errorText(obj) };
    }

    if (type === 'item.completed') {
      const item = itemObject(obj);
      const itemType = typeof item?.type === 'string' ? item.type : '';
      if (itemType === 'agent_message') {
        const text = typeof item?.text === 'string' ? item.text : undefined;
        return { ts: Date.now(), stream, kind: 'output', raw, ...(text ? { text } : {}) };
      }
      if (itemType === 'reasoning') {
        const text = typeof item?.text === 'string' ? item.text : undefined;
        return { ts: Date.now(), stream, kind: 'noise', raw, ...(text ? { text } : {}) };
      }
      if (itemType === 'error') {
        const message = typeof item?.message === 'string' ? item.message : undefined;
        return { ts: Date.now(), stream, kind: 'noise', raw, ...(message ? { text: message } : {}) };
      }
      if (itemType === 'file_change') {
        // Extract paths from the FULL parsed item NOW — `raw` is truncated below, and the
        // sandbox-escape check must never depend on a clipped line (security: a long
        // file_change would re-parse to [] and falsely look confined).
        return { ts: Date.now(), stream, kind: 'output', raw, filePaths: pathsFromChanges(item!) };
      }
      if (TOOL_ITEM_TYPES.has(itemType)) {
        return { ts: Date.now(), stream, kind: 'output', raw };
      }
    }

    return { ts: Date.now(), stream, kind: 'output', raw };
  },

  finalSummary(stdoutTail: string, events: WorkerEvent[]): string {
    for (let i = events.length - 1; i >= 0; i--) {
      const text = agentMessageText(events[i]!);
      if (text.trim() !== '') return text;
    }
    const lines = stdoutTail.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-30).join('\n');
  },

  finalUsage(events: WorkerEvent[]): { tokens?: TokenUsage; iterations?: number } {
    let tokens: TokenUsage | undefined;
    let iterations = 0;

    for (const ev of events) {
      // Use the turn data extracted at parse time (ev.kind/ev.tokens). Re-parsing the
      // truncated ev.raw would drop usage and undercount iterations on long turn lines.
      if (ev.kind === 'turn') {
        iterations += 1;
        if (ev.tokens) tokens = ev.tokens;
      }
    }

    return { tokens, iterations };
  },

  assessSandbox(events: WorkerEvent[], worktree: string): { confined: boolean; detail?: string } | null {
    for (const ev of events) {
      for (const p of ev.filePaths ?? []) {
        const rel = path.relative(worktree, path.resolve(worktree, p));
        const outside = rel.startsWith('..') || path.isAbsolute(rel);
        if (outside) {
          return { confined: false, detail: `codex wrote outside the worktree: ${p}` };
        }
      }
    }
    return { confined: true };
  },
};

function itemObject(obj: Record<string, unknown>): Record<string, unknown> | null {
  const item = obj.item;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  return item as Record<string, unknown>;
}

function usageFromTurnCompleted(obj: Record<string, unknown>): TokenUsage | undefined {
  const usage = obj.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const u = usage as Record<string, unknown>;
  return normalizeCodexTokens({
    input: numberValue(u.input_tokens),
    output: numberValue(u.output_tokens),
    reasoning: numberValue(u.reasoning_output_tokens),
  });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function normalizeCodexTokens(tokens: TokenUsage | undefined): TokenUsage | undefined {
  if (!tokens) return undefined;
  if (tokens.total !== undefined) return tokens;
  if (tokens.input !== undefined && tokens.output !== undefined) {
    return { ...tokens, total: tokens.input + tokens.output };
  }
  return tokens;
}

function agentMessageText(ev: WorkerEvent): string {
  if (ev.text && ev.kind === 'output') return ev.text;
  try {
    const parsed = JSON.parse(ev.raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'item.completed') return '';
    const item = itemObject(obj);
    if (item?.type !== 'agent_message') return '';
    return typeof item.text === 'string' ? item.text : '';
  } catch {
    return '';
  }
}

function errorText(obj: Record<string, unknown>): string {
  const err = obj.error;
  if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return typeof obj.message === 'string' ? obj.message : '';
}

/** Extract written paths from a parsed file_change item (NOT from a possibly-truncated raw line). */
function pathsFromChanges(item: Record<string, unknown>): string[] {
  const changes = item.changes;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    if (change === null || typeof change !== 'object' || Array.isArray(change)) return [];
    const p = (change as Record<string, unknown>).path;
    return typeof p === 'string' && p !== '' ? [p] : [];
  });
}

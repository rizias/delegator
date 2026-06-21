import { ConfigError } from '../config.js';
import type { TokenUsage, WorkerEvent, WorkerRuntimeAdapter } from '../types.js';
import { claudeStreamJsonParser } from './claude-stream-json.js';
import { codexExecJsonParser } from './codex-exec-json.js';
import { genericLinesParser } from './generic-lines.js';
import { opencodeNdjsonParser } from './opencode-ndjson.js';
import { openaiChatParser, type ResponseParseResult } from './openai-chat.js';
import { piNdjsonParser } from './pi-ndjson.js';

export interface ParserPreset {
  parseLine(line: string, stream: 'stdout' | 'stderr'): WorkerEvent;
  finalSummary(stdoutTail: string, events: WorkerEvent[]): string;
  finalUsage(events: WorkerEvent[]): { tokens?: TokenUsage; iterations?: number };
  classifyExit?: WorkerRuntimeAdapter['classifyExit'];
  assessSandbox?: WorkerRuntimeAdapter['assessSandbox'];
}

export interface ResponseParserPreset {
  parse(json: unknown): ResponseParseResult;
}

export const PARSERS: Record<string, ParserPreset> = {
  'builtin:generic-lines': genericLinesParser,
  'builtin:claude-stream-json-events': claudeStreamJsonParser,
  'builtin:codex-exec-json-events': codexExecJsonParser,
  'builtin:opencode-run-json-events': opencodeNdjsonParser,
  'builtin:pi-json-events': piNdjsonParser,
};

export const RESPONSE_PARSERS: Record<string, ResponseParserPreset> = {
  'builtin:openai-chat': openaiChatParser,
  'openai-chat': openaiChatParser,
};

export function getParser(name: string): ParserPreset {
  const parser = PARSERS[name];
  if (!parser) throw new ConfigError(`Unknown parser preset "${name}"`);
  return parser;
}

export function getResponseParser(name: string): ResponseParserPreset {
  const exact = RESPONSE_PARSERS[name];
  if (exact) return exact;
  const normalized = name.startsWith('builtin:') ? name.slice('builtin:'.length) : name;
  const parser = RESPONSE_PARSERS[normalized];
  if (!parser) throw new ConfigError(`Unknown response parser preset "${name}"`);
  return parser;
}

export function parseResponseByName(name: string, json: unknown): ResponseParseResult {
  return getResponseParser(name).parse(json);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../config.js';
import { getParser, PARSERS, type ParserPreset } from '../parsers/registry.js';
import type { RuntimeArg, RuntimeContext, RuntimeDescriptor, SpawnSpec, WorkerRuntimeAdapter } from '../types.js';
import { CLAUDE_WORKTREE_BOUNDARY_PROMPT, PI_WORKTREE_BOUNDARY_PROMPT } from './builtins.js';

export type PlaceholderValues = Record<string, string>;

// Run-scoped scratch dirs (the prompt file, an isolated CLAUDE_CONFIG_DIR) sit next to the
// worktree — i.e. inside the run dir (~/.delegator/<runId>/), so they are removed with the run.
// Fall back to the OS temp dir when the worktree path is not absolute, so a malformed context
// can never create scratch dirs in the current working directory (e.g. a checked-out repo).
function runScratchBase(worktree: string): string {
  return path.isAbsolute(worktree) ? path.dirname(worktree) : os.tmpdir();
}

const TOKEN_RE = /{{\s*([^{}]+?)\s*}}/g;
const STATIC_TOKENS = new Set([
  'model.id',
  'brief',
  'maxTokens',
  'reasoningEffort',
  'permissionMode',
  'worktree',
  'promptFile',
  'budget.wallClockMs',
  'provider.baseUrl',
  'provider.id',
  'secret',
  'secret(provider.id)',
  'tier.tools',
  'worktreeBoundaryPrompt',
]);

export function descriptorToAdapter(
  id: string,
  descriptor: RuntimeDescriptor,
  parsers: Record<string, ParserPreset> = PARSERS,
): WorkerRuntimeAdapter {
  if (descriptor.mode === 'direct-api' || descriptor.parser === 'none') {
    throw new ConfigError(`Runtime "${id}" is in-process and cannot be converted to a spawn adapter`);
  }
  if (!descriptor.command) {
    throw new ConfigError(`Runtime "${id}" is missing command`);
  }

  const parserName = descriptor.parser ?? descriptor.output?.parser;
  if (!parserName) throw new ConfigError(`Runtime "${id}" is missing parser`);
  validateDescriptorTokens(id, descriptor);
  const parser = resolveParser(id, parserName, parsers);

  return {
    id,
    binary: descriptor.command,

    buildSpawn(ctx: RuntimeContext): SpawnSpec {
      const promptMode = descriptor.prompt?.mode ?? 'stdin';
      let promptFile = '';
      if (promptMode === 'file') {
        const dir = fs.mkdtempSync(path.join(runScratchBase(ctx.worktree), 'prompt-'));
        promptFile = path.join(dir, 'brief.md');
        fs.writeFileSync(promptFile, ctx.brief, 'utf8');
      }

      const values = placeholderValues(id, ctx, promptFile);
      const args = renderArgs(descriptor.args ?? [], values);
      const env = renderEnv(descriptor.env ?? {}, values);
      const spec: SpawnSpec = {
        command: descriptor.command!,
        args,
        env,
        cwd: ctx.worktree,
      };

      applyEquipment(id, ctx, spec);

      // A subscription runtime authenticates through its CLI's OWN login, which (for some CLIs, e.g.
      // claude) rides host env vars in this runtime's declared `authEnv` namespace. Those would be
      // stripped by workerEnv's credential denylist (-> 401), so preserve them — but ONLY for
      // subscription auth. An api-key worker keeps the host stripped and receives its key via
      // spec.env, so one provider's host login never leaks into another provider's worker. Any new
      // login-based CLI just declares its own `authEnv` in the descriptor — no code change.
      if (descriptor.authEnv?.length && ctx.resolved.provider.auth === 'subscription') {
        spec.preserveEnv = [...(spec.preserveEnv ?? []), ...descriptor.authEnv];
      }

      for (const extra of ctx.resolved.worker.extraArgs ?? []) {
        spec.args.push(extra);
      }

      if (promptMode === 'stdin') {
        spec.stdinData = ctx.brief;
      } else if (promptMode === 'argv-last') {
        spec.args.push(ctx.brief);
      }

      return spec;
    },

    parseLine: parser.parseLine,
    finalSummary: parser.finalSummary,
    finalUsage: parser.finalUsage,
    ...(parser.classifyExit ? { classifyExit: parser.classifyExit } : {}),
    ...(parser.assessSandbox ? { assessSandbox: parser.assessSandbox } : {}),
  };
}

function resolveParser(id: string, parserName: string, parsers: Record<string, ParserPreset>): ParserPreset {
  const exact = parsers[parserName];
  if (exact) return exact;
  const normalized = parserName.startsWith('builtin:') ? parserName.slice('builtin:'.length) : parserName;
  const parser = parsers[normalized];
  if (!parser) {
    if (parsers === PARSERS) return getParser(parserName);
    throw new ConfigError(`Runtime "${id}" references unknown parser "${parserName}"`);
  }
  return parser;
}

export function validateDescriptorTokens(id: string, descriptor: RuntimeDescriptor): void {
  const check = (s: string) => {
    for (const match of s.matchAll(TOKEN_RE)) {
      const token = match[1]!.trim();
      if (!isAllowedToken(token)) {
        throw new ConfigError(`Runtime "${id}" references unknown template token "{{${token}}}"`);
      }
    }
  };

  for (const arg of descriptor.args ?? []) {
    if (Array.isArray(arg)) {
      for (const part of arg) check(part);
    } else {
      check(arg);
    }
  }
  for (const value of Object.values(descriptor.env ?? {})) {
    check(value);
  }
  for (const value of Object.values(descriptor.request?.headers ?? {})) {
    check(value);
  }
  checkStringLeaves(descriptor.request?.json, check);
}

function isAllowedToken(token: string): boolean {
  return STATIC_TOKENS.has(token) || parseDefaultedToken(token) !== null;
}

export function placeholderValues(id: string, ctx: RuntimeContext, promptFile = ''): PlaceholderValues {
  const effort = ctx.resolved.worker.reasoningEffort ?? '';
  const boundary = id === 'pi' ? PI_WORKTREE_BOUNDARY_PROMPT : CLAUDE_WORKTREE_BOUNDARY_PROMPT;
  return {
    'model.id': ctx.resolved.worker.model ?? '',
    brief: ctx.brief,
    maxTokens: '',
    reasoningEffort: effort,
    permissionMode: '',
    worktree: ctx.worktree,
    promptFile,
    'budget.wallClockMs': String(ctx.budget.wallClockMs),
    'provider.baseUrl': ctx.resolved.provider.baseUrl ?? '',
    'provider.id': ctx.resolved.providerId,
    secret: ctx.resolved.apiKey ?? '',
    'secret(provider.id)': ctx.resolved.apiKey ?? '',
    'tier.tools': ctx.tier?.tools?.join(',') ?? '',
    worktreeBoundaryPrompt: renderTemplate(boundary, {
      worktree: ctx.worktree,
    }),
  };
}

function renderArgs(args: RuntimeArg[], values: PlaceholderValues): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      const rendered = arg.map((part) => renderTemplate(part, values));
      if (arg.some((part) => hasEmptyPlaceholder(part, values))) continue;
      out.push(...rendered);
    } else {
      out.push(renderTemplate(arg, values));
    }
  }
  return out;
}

function renderEnv(env: Record<string, string>, values: PlaceholderValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const rendered = renderTemplate(value, values);
    if (rendered !== '') out[key] = rendered;
  }
  return out;
}

export function renderTemplate(template: string, values: PlaceholderValues): string {
  return template.replace(TOKEN_RE, (_all, tokenRaw: string) => {
    const token = tokenRaw.trim();
    const defaulted = parseDefaultedToken(token);
    if (defaulted) return values[defaulted.token] || defaulted.defaultValue;
    return values[token] ?? '';
  });
}

export function hasEmptyPlaceholder(value: string, values: PlaceholderValues): boolean {
  for (const match of value.matchAll(TOKEN_RE)) {
    const token = match[1]!.trim();
    const defaulted = parseDefaultedToken(token);
    if (defaulted) {
      if ((values[defaulted.token] || defaulted.defaultValue) === '') return true;
      continue;
    }
    if ((values[token] ?? '') === '') return true;
  }
  return false;
}

function parseDefaultedToken(token: string): { token: string; defaultValue: string } | null {
  const match = /^([^{}:]+):([^{}]*)$/.exec(token);
  if (!match) return null;
  return { token: match[1]!.trim(), defaultValue: match[2]!.trim() };
}

function checkStringLeaves(value: unknown, check: (s: string) => void): void {
  if (typeof value === 'string') {
    check(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkStringLeaves(item, check);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) checkStringLeaves(item, check);
  }
}

function applyEquipment(id: string, ctx: RuntimeContext, spec: SpawnSpec): void {
  if (id === 'claude') {
    const tools =
      ctx.toolsOverride ??
      ctx.resolved.worker.equip?.tools ??
      ctx.resolved.worker.tools ??
      ctx.tier?.tools ??
      ctx.defaultsTools;
    if (tools?.length) {
      insertBeforeFlag(spec.args, '--disallowedTools', ['--allowedTools', tools.join(',')]);
    }
    for (const mcp of ctx.resolved.worker.equip?.mcp ?? []) {
      insertBeforeFlag(spec.args, '--disallowedTools', ['--mcp-config', mcp]);
    }
    // An api-key claude worker (z.ai/GLM/MiMo on the claude runtime) must NOT inherit the host's
    // Claude *subscription* login: when the user is logged into Claude Code, the OAuth in ~/.claude
    // shadows the injected ANTHROPIC_AUTH_TOKEN and the CLI authenticates as the subscription ->
    // 401 against the api-key endpoint (proven: inheriting fails, a clean config dir works; this
    // hits the frozen 0.3.15 too, so it is not the env-strip change). A throwaway CLAUDE_CONFIG_DIR
    // isolates it so the injected key is used. Subscription workers still inherit (they NEED that
    // login). An explicit equip.profile wins either way. Trade-off: a clean api-key worker does not
    // inherit ~/.claude MCP/skills — pass them with equip.mcp / equip.tools when needed.
    const profile = ctx.resolved.worker.equip?.profile;
    const useCleanConfig = profile === 'clean'
      || (profile !== 'inherit' && ctx.resolved.provider.auth === 'api-key');
    if (useCleanConfig) {
      spec.env['CLAUDE_CONFIG_DIR'] = fs.mkdtempSync(path.join(runScratchBase(ctx.worktree), 'claude-config-'));
    }
    if (ctx.resolved.provider.kind !== 'anthropic-compatible') {
      delete spec.env['ANTHROPIC_MODEL'];
      delete spec.env['ANTHROPIC_SMALL_FAST_MODEL'];
      delete spec.env['ANTHROPIC_DEFAULT_OPUS_MODEL'];
      delete spec.env['ANTHROPIC_DEFAULT_SONNET_MODEL'];
      delete spec.env['ANTHROPIC_DEFAULT_HAIKU_MODEL'];
    }
    return;
  }

  if (id === 'codex') {
    if ((ctx.resolved.worker.extraArgs ?? []).some((arg) => arg.includes('model_reasoning_effort'))) {
      removeFlagValue(spec.args, '-c', (value) => value.includes('model_reasoning_effort'));
    }
    return;
  }

  if (id === 'opencode') {
    if (ctx.resolved.worker.equip?.profile !== 'inherit' && !spec.args.includes('--pure')) {
      insertBeforeFlag(spec.args, '--dangerously-skip-permissions', ['--pure']);
    }
    return;
  }

  if (id === 'pi') {
    // worker-runtime equipment (CLI --skill toggles), NOT host instruction packs
    for (const skill of ctx.resolved.worker.equip?.skills ?? []) {
      spec.args.push('--skill', skill);
    }
    const tools = ctx.resolved.worker.equip?.tools;
    if (Array.isArray(tools)) {
      if (tools.length === 0) spec.args.push('--no-tools');
      else spec.args.push('--tools', tools.join(','));
    }
  }
}

function insertBeforeFlag(args: string[], flag: string, values: string[]): void {
  const idx = args.indexOf(flag);
  if (idx === -1) args.push(...values);
  else args.splice(idx, 0, ...values);
}

function removeFlagValue(args: string[], flag: string, shouldRemoveValue: (value: string) => boolean): void {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && shouldRemoveValue(args[i + 1]!)) {
      args.splice(i, 2);
      i -= 1;
    }
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { descriptorToAdapter } from '../dist/runtimes/factory.js';
import { buildRuntimeRegistry } from '../dist/runtimes/index.js';
import { ConfigError, mergedRuntimeDescriptors } from '../dist/config.js';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-runtime-factory-'));
const runtimeDescriptors = mergedRuntimeDescriptors({});

function ctx(runtime, workerOver = {}, providerOver = {}) {
  return {
    brief: 'line one\nline two',
    worktree: '/wt',
    budget: { wallClockMs: 1000 },
    tier: { chain: ['w'], fallback: 'report', tools: ['Read'] },
    resolved: {
      workerId: 'w',
      providerId: providerOver.id ?? 'p',
      worker: {
        provider: providerOver.id ?? 'p',
        model: 'm',
        runtime,
        reasoningEffort: 'high',
        equip: { tools: ['Read', 'Edit'] },
        ...workerOver,
      },
      provider: {
        kind: 'anthropic-compatible',
        baseUrl: 'https://x.example/anthropic',
        ...providerOver,
      },
      apiKey: 'k',
    },
  };
}

test('reasoning effort wires to each runtime flag and drops when unset', () => {
  const args = (rt, eff) =>
    descriptorToAdapter(rt, runtimeDescriptors[rt]).buildSpawn(ctx(rt, { reasoningEffort: eff })).args;
  // claude → --effort <level>
  const cl = args('claude', 'high');
  assert.equal(cl[cl.indexOf('--effort') + 1], 'high');
  assert.ok(!args('claude', undefined).includes('--effort'), 'claude --effort drops when effort unset');
  // codex → -c model_reasoning_effort="<level>"
  assert.ok(args('codex', 'high').includes('model_reasoning_effort="high"'));
  assert.ok(
    !args('codex', undefined).some((a) => a.startsWith('model_reasoning_effort=')),
    'codex effort drops when unset (uses codex default)',
  );
  // opencode → --variant <level>
  const oc = args('opencode', 'high');
  assert.equal(oc[oc.indexOf('--variant') + 1], 'high');
  assert.ok(!args('opencode', undefined).includes('--variant'), 'opencode --variant drops when effort unset');
});

test('built-in claude descriptor builds the claude spawn spec', () => {
  const c = ctx('claude', { model: 'glm-5-turbo' });
  const spec = descriptorToAdapter('claude', runtimeDescriptors.claude).buildSpawn(c);
  assert.equal(spec.command, 'claude');
  assert.equal(spec.stdinData, c.brief);
  assert.equal(spec.env.ANTHROPIC_MODEL, 'glm-5-turbo');
});

test('built-in codex descriptor builds the codex spawn spec', () => {
  const c = ctx('codex', { model: 'gpt-5.5' }, { kind: 'codex-cli' });
  const spec = descriptorToAdapter('codex', runtimeDescriptors.codex).buildSpawn(c);
  assert.equal(spec.command, 'codex');
  assert.equal(spec.stdinData, c.brief);
  assert.equal(spec.args.at(-1), '-');
});

test('built-in opencode descriptor builds the opencode spawn spec', () => {
  const c = ctx('opencode', { model: 'opencode/north-mini-code-free' }, { id: 'opencode', kind: 'opencode' });
  const spec = descriptorToAdapter('opencode', runtimeDescriptors.opencode).buildSpawn(c);
  assert.equal(spec.command, 'opencode');
  assert.equal(spec.stdinData, undefined);
  assert.equal(spec.args.at(-1), c.brief);
  assert.equal(spec.env.PWD, c.worktree);
});

test('built-in pi descriptor builds the pi spawn spec', () => {
  const c = ctx('pi', { model: 'gpt-5.5' }, { id: 'openai-codex', kind: 'codex-cli' });
  const spec = descriptorToAdapter('pi', runtimeDescriptors.pi).buildSpawn(c);
  assert.equal(spec.command, 'pi');
  assert.equal(spec.stdinData, c.brief);
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'openai-codex/gpt-5.5');
});

test('buildRuntimeRegistry uses built-ins and cfg.runtimes overrides', () => {
  const registry = buildRuntimeRegistry({
    runtimes: {
      codex: {
        mode: 'command',
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        prompt: { mode: 'stdin' },
        parser: 'builtin:generic-lines',
      },
    },
  });
  assert.equal(registry.claude.buildSpawn(ctx('claude')).command, 'claude');
  assert.equal(registry.codex.buildSpawn(ctx('codex')).command, 'node');
  assert.equal(registry.api.id, 'api');
});

test('generic-lines maps every stdout line to output and summarizes last non-empty lines', () => {
  const adapter = descriptorToAdapter('x', {
    mode: 'command',
    command: 'x',
    args: [],
    prompt: { mode: 'stdin' },
    parser: 'builtin:generic-lines',
  });
  const ev = adapter.parseLine('hello', 'stdout');
  assert.equal(ev.kind, 'output');
  assert.equal(adapter.finalSummary('\nA\n\nB\n', [ev]), 'A\nB');
  assert.deepEqual(adapter.finalUsage([ev]), {});
});

test('unknown placeholder throws at factory-build time', () => {
  assert.throws(
    () => descriptorToAdapter('bad-runtime', {
      mode: 'command',
      command: 'x',
      args: ['{{typo}}'],
      prompt: { mode: 'stdin' },
      parser: 'builtin:generic-lines',
    }),
    (e) => e instanceof ConfigError && /bad-runtime/.test(e.message) && /typo/.test(e.message),
  );
});

test('unknown parser throws at factory-build time', () => {
  assert.throws(
    () => descriptorToAdapter('bad-parser', {
      mode: 'command',
      command: 'x',
      args: [],
      prompt: { mode: 'stdin' },
      parser: 'missing-parser',
    }),
    (e) => e instanceof ConfigError && /missing-parser/.test(e.message),
  );
});

test('conditional arg group is dropped when any placeholder renders empty', () => {
  const adapter = descriptorToAdapter('x', {
    mode: 'command',
    command: 'x',
    args: [['--model', '{{model.id}}'], 'run'],
    prompt: { mode: 'stdin' },
    parser: 'builtin:generic-lines',
  });
  assert.deepEqual(adapter.buildSpawn(ctx('x', { model: undefined })).args, ['run']);
});

test('defaulted placeholders render the default when empty and the value when present', () => {
  const adapter = descriptorToAdapter('x', {
    mode: 'command',
    command: 'x',
    args: ['{{anything:def}}', '{{model.id:def}}'],
    prompt: { mode: 'stdin' },
    parser: 'builtin:generic-lines',
  });
  assert.deepEqual(adapter.buildSpawn(ctx('x')).args, ['def', 'm']);
});

test('prompt.mode file writes the brief to a temp file and exposes promptFile', () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-factory-'));
  const worktree = path.join(runRoot, 'worktree');
  fs.mkdirSync(worktree);
  const adapter = descriptorToAdapter('x', {
    mode: 'command',
    command: 'x',
    args: ['--prompt', '{{promptFile}}'],
    prompt: { mode: 'file' },
    parser: 'builtin:generic-lines',
  });
  const spec = adapter.buildSpawn({ ...ctx('x'), brief: 'BRIEF', worktree });
  const promptPath = spec.args[spec.args.indexOf('--prompt') + 1];
  assert.ok(promptPath.startsWith(runRoot + path.sep));
  assert.equal(fs.readFileSync(promptPath, 'utf8'), 'BRIEF');
  assert.equal(spec.stdinData, undefined);
});

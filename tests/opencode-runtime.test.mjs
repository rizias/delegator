// Regressions for the opencode-run runtime. The hard-won facts:
// opencode ignores stdin, so the brief travels via argv (safe: it is a real .exe,
// not a .cmd shim); a step is one model turn; tokens come on step-finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-oc-'));
const { descriptorToAdapter } = await import('../dist/runtimes/factory.js');
const { loadConfig, mergedRuntimeDescriptors } = await import('../dist/config.js');

const opencodeRuntime = descriptorToAdapter('opencode', mergedRuntimeDescriptors({}).opencode);

function ctxFor(model, brief = 'multi\nline\nbrief') {
  return {
    brief,
    worktree: '/wt',
    budget: { wallClockMs: 1000 },
    resolved: {
      workerId: 'w',
      providerId: 'opencode',
      worker: { provider: 'opencode', model, runtime: 'opencode' },
      provider: { kind: 'opencode', auth: 'subscription' },
    },
  };
}

test('brief travels via argv (last positional), NEVER stdin', () => {
  const brief = 'line one\nline two\nline three';
  const spec = opencodeRuntime.buildSpawn(ctxFor('opencode/north-mini-code-free', brief));
  // opencode ignores stdin (verified live) — unlike claude/codex there is no stdinData.
  assert.equal(spec.stdinData, undefined);
  // The multiline brief is the final argv argument, intact.
  assert.equal(spec.args[spec.args.length - 1], brief);
});

test('model is passed through as -m provider/model', () => {
  const spec = opencodeRuntime.buildSpawn(ctxFor('github-copilot/gpt-5.5'));
  const i = spec.args.indexOf('-m');
  assert.notEqual(i, -1);
  assert.equal(spec.args[i + 1], 'github-copilot/gpt-5.5');
});

test('spawns headless: json format, clean profile, skip-permissions; root via cwd, NOT --dir', () => {
  const spec = opencodeRuntime.buildSpawn(ctxFor('opencode/deepseek-v4-flash-free'));
  assert.equal(spec.command, 'opencode');
  assert.equal(spec.args[0], 'run');
  assert.ok(spec.args.includes('--format') && spec.args[spec.args.indexOf('--format') + 1] === 'json');
  assert.ok(spec.args.includes('--pure'));
  assert.ok(spec.args.includes('--dangerously-skip-permissions'));
  // --dir would remap the project to a virtual /workspace and the worker's writes
  // would escape the worktree (verified live) — the worktree is the spawn cwd instead.
  assert.ok(!spec.args.includes('--dir'));
  assert.equal(spec.cwd, '/wt');
  // opencode roots on PWD, not the OS cwd — pin it to the worktree or the worker
  // writes into the parent process's directory and escapes isolation (verified live).
  assert.equal(spec.env.PWD, '/wt');
});

test('extraArgs are appended verbatim before the brief', () => {
  const ctx = ctxFor('opencode/north-mini-code-free', 'BRIEF');
  ctx.resolved.worker.extraArgs = ['--variant', 'high'];
  const spec = opencodeRuntime.buildSpawn(ctx);
  const v = spec.args.indexOf('--variant');
  assert.notEqual(v, -1);
  assert.equal(spec.args[v + 1], 'high');
  assert.equal(spec.args[spec.args.length - 1], 'BRIEF'); // brief still last
});

test('step-start counts as one model turn (counted for stats)', () => {
  const line = JSON.stringify({ type: 'step_start', part: { type: 'step-start' } });
  assert.equal(opencodeRuntime.parseLine(line, 'stdout').kind, 'turn');
});

test('step-finish is usage, NOT a turn (counting both would double iterations)', () => {
  const line = JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', tokens: { input: 100, output: 10, reasoning: 5, total: 115 } },
  });
  const ev = opencodeRuntime.parseLine(line, 'stdout');
  assert.equal(ev.kind, 'usage');
  // reasoning is reported separately; total includes input + output + reasoning.
  assert.equal(ev.tokens.input, 100);
  assert.equal(ev.tokens.output, 10);
  assert.equal(ev.tokens.reasoning, 5);
  assert.equal(ev.tokens.total, 115);
});

test('finalUsage sums per-turn tokens and counts completed turns', () => {
  const events = [
    opencodeRuntime.parseLine(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 100, output: 10, reasoning: 0 } } }), 'stdout'),
    opencodeRuntime.parseLine(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 200, output: 20, reasoning: 5 } } }), 'stdout'),
  ];
  const u = opencodeRuntime.finalUsage(events);
  assert.equal(u.iterations, 2);
  assert.equal(u.tokens.input, 300);
  assert.equal(u.tokens.output, 30);
  assert.equal(u.tokens.reasoning, 5);
  assert.equal(u.tokens.total, 335);
});

test('finalSummary prefers assistant text, else falls back to the last tool', () => {
  const textEv = opencodeRuntime.parseLine(JSON.stringify({ type: 'text', part: { type: 'text', text: 'all done' } }), 'stdout');
  assert.equal(opencodeRuntime.finalSummary('', [textEv]), 'all done');

  // No text part (the common case for weak free workers): summarise the last tool.
  const toolEv = opencodeRuntime.parseLine(JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'write', state: { status: 'completed', output: 'Wrote file successfully.' } } }), 'stdout');
  const fb = opencodeRuntime.finalSummary('', [toolEv]);
  assert.match(fb, /no final message/);
  assert.match(fb, /write/);
});

test('stdout type:error is an error signal, not a successful answer', () => {
  const line = JSON.stringify({
    type: 'error',
    error: { name: 'APIError', data: { message: 'Unauthorized', statusCode: 401 } },
  });
  assert.equal(opencodeRuntime.parseLine(line, 'stdout').kind, 'error');
});

test('stderr ANSI TUI noise is classified noise, not summary content', () => {
  assert.equal(opencodeRuntime.parseLine('\x1b[0m', 'stderr').kind, 'noise');
  assert.equal(opencodeRuntime.parseLine('', 'stderr').kind, 'noise');
});

test('runtime is INFERRED from provider kind opencode (worker entry needs no runtime:)', () => {
  const home = process.env.DELEGATOR_HOME;
  fs.writeFileSync(path.join(home, 'providers.yaml'), [
    'version: 1',
    'providers:',
    '  opencode:',
    '    kind: opencode',
    'workers:',
    '  oc-free:',
    '    provider: opencode',
    '    model: opencode/north-mini-code-free',
    'tiers: {}',
    '',
  ].join('\n'), 'utf8');
  const cfg = loadConfig(home);
  assert.equal(cfg.workers['oc-free'].runtime, 'opencode');
});

test('equip.profile inherit lets opencode load the host profile by dropping --pure', () => {
  const ctx = ctxFor('opencode/north-mini-code-free');
  ctx.resolved.worker.equip = { profile: 'inherit' };
  const spec = opencodeRuntime.buildSpawn(ctx);
  assert.ok(!spec.args.includes('--pure'));
});

test('equip.profile clean and absent keep opencode --pure', () => {
  const cleanCtx = ctxFor('opencode/north-mini-code-free');
  cleanCtx.resolved.worker.equip = { profile: 'clean' };
  assert.ok(opencodeRuntime.buildSpawn(cleanCtx).args.includes('--pure'));

  const absentCtx = ctxFor('opencode/north-mini-code-free');
  assert.ok(opencodeRuntime.buildSpawn(absentCtx).args.includes('--pure'));
});

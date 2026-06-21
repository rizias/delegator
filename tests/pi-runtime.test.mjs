import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { descriptorToAdapter } = await import('../dist/runtimes/factory.js');
const { mergedRuntimeDescriptors } = await import('../dist/config.js');

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-pi-runtime-'));
const piRuntime = descriptorToAdapter('pi', mergedRuntimeDescriptors({}).pi);

function ctx(workerOver = {}) {
  return {
    brief: 'line one\nline two',
    worktree: '/wt',
    budget: { wallClockMs: 1000 },
    resolved: {
      workerId: 'pi-gpt',
      providerId: 'openai-codex',
      worker: { provider: 'openai-codex', model: 'gpt-5.5', runtime: 'pi', ...workerOver },
      provider: { kind: 'codex-cli', protocol: 'openai', auth: 'subscription' },
    },
  };
}

test('buildSpawn sends the brief via stdinData, not argv', () => {
  const spec = piRuntime.buildSpawn(ctx());
  assert.equal(spec.command, 'pi');
  assert.equal(spec.stdinData, 'line one\nline two');
  assert.ok(!spec.args.includes('line one\nline two'));
});

test('buildSpawn maps provider/model and reasoningEffort to pi flags', () => {
  const spec = piRuntime.buildSpawn(ctx({ reasoningEffort: 'xhigh' }));
  assert.equal(spec.args[spec.args.indexOf('--provider') + 1], 'openai-codex');
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'openai-codex/gpt-5.5');
  assert.equal(spec.args[spec.args.indexOf('--thinking') + 1], 'xhigh');
});

test('buildSpawn defaults thinking to medium and passes no api key', () => {
  const spec = piRuntime.buildSpawn(ctx());
  assert.equal(spec.args[spec.args.indexOf('--thinking') + 1], 'medium');
  assert.ok(!spec.args.includes('--api-key'));
  assert.deepEqual(spec.env, {});
});

test('buildSpawn maps equip skills and tools', () => {
  const spec = piRuntime.buildSpawn(ctx({ equip: { skills: ['qa-review', 'ts'], tools: ['Read', 'Edit'] } }));
  const skillPositions = spec.args
    .map((arg, i) => [arg, i])
    .filter(([arg]) => arg === '--skill')
    .map(([, i]) => i);
  assert.deepEqual(skillPositions.map((i) => spec.args[i + 1]), ['qa-review', 'ts']);
  assert.equal(spec.args[spec.args.indexOf('--tools') + 1], 'Read,Edit');
});

test('buildSpawn maps explicit empty tools to --no-tools', () => {
  const spec = piRuntime.buildSpawn(ctx({ equip: { tools: [] } }));
  assert.ok(spec.args.includes('--no-tools'));
  assert.ok(!spec.args.includes('--tools'));
});

test('parseLine maps turn_start to turn', () => {
  const ev = piRuntime.parseLine(JSON.stringify({ type: 'turn_start' }), 'stdout');
  assert.equal(ev.kind, 'turn');
});

test('parseLine maps assistant message_end to result with text and tokens', () => {
  const ev = piRuntime.parseLine(JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }],
      usage: { input: 10, output: 5, totalTokens: 15 },
    },
  }), 'stdout');
  assert.equal(ev.kind, 'result');
  assert.equal(ev.text, 'hello world');
  assert.deepEqual(ev.tokens, { input: 10, output: 5, total: 15 });
});

test('finalUsage reads the last usage and counts turn_start iterations', () => {
  const events = [
    piRuntime.parseLine(JSON.stringify({ type: 'turn_start' }), 'stdout'),
    piRuntime.parseLine(JSON.stringify({ type: 'turn_start' }), 'stdout'),
    piRuntime.parseLine(JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], usage: { input: 10, output: 5, totalTokens: 15 } },
    }), 'stdout'),
  ];
  const usage = piRuntime.finalUsage(events);
  assert.equal(usage.iterations, 2);
  assert.deepEqual(usage.tokens, { input: 10, output: 5, total: 15 });
});


import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-council-'));

const { buildBundle, sumCouncilUsage, newCouncilId, validateCouncilModels } = await import('../dist/council.js');
const { ConfigError } = await import('../dist/config.js');

function candidate(workerId, answer, extra = {}) {
  return {
    workerId,
    status: 'completed',
    answer,
    filesTouched: [],
    attempts: 1,
    durationMs: 10,
    ...extra,
  };
}

test('buildBundle includes full answers, task, optional diffs, and compact numbering', () => {
  const longAnswer = `${'x'.repeat(9500)}TAIL-SURVIVES`;
  const bundle = buildBundle('original task', [
    candidate('empty', '   '),
    candidate('a', longAnswer, { diff: 'diff --git a/a b/a\n+hi' }),
    candidate('b', 'second answer'),
    candidate('nodiff', 'third answer', { diff: '  ' }),
  ]);

  assert.match(bundle, /## Task\noriginal task/);
  assert.ok(bundle.includes('TAIL-SURVIVES'));
  assert.match(bundle, /## Candidate 1: a/);
  assert.match(bundle, /## Candidate 2: b/);
  assert.match(bundle, /## Candidate 3: nodiff/);
  assert.doesNotMatch(bundle, /## Candidate \d+: empty/);
  assert.match(bundle, /### Diff\n```diff\ndiff --git a\/a b\/a\n\+hi\n```/);
  assert.equal((bundle.match(/### Diff/g) ?? []).length, 1);
});

test('sumCouncilUsage sums reported tokens and treats missing fields as zero', () => {
  assert.deepEqual(sumCouncilUsage([
    candidate('a', 'x', { tokens: { input: 1, output: 2, reasoning: 3, total: 6 } }),
    candidate('b', 'x', { tokens: { input: 10, output: 20, total: 30 } }),
    candidate('c', 'x'),
  ], 123), {
    inputTokens: 11,
    outputTokens: 22,
    reasoningTokens: 3,
    totalTokens: 36,
    calls: 3,
    wallClockMs: 123,
  });
});

test('newCouncilId uses the council timestamp and hex suffix shape', () => {
  assert.match(newCouncilId(), /^council_\d{13}_[0-9a-f]{6}$/);
});

test('validateCouncilModels: fewer than 2 models is rejected', () => {
  assert.throws(
    () => validateCouncilModels([{ handle: 'openai-codex/gpt-5.5' }]),
    (e) => e instanceof ConfigError && /at least 2 different models/.test(e.message),
  );
});

test('validateCouncilModels: duplicate handles are rejected', () => {
  assert.throws(
    () => validateCouncilModels([
      { handle: 'openai-codex/gpt-5.5' },
      { handle: 'openai-codex/gpt-5.5' },
    ]),
    (e) => e instanceof ConfigError && /Duplicate council model handle/.test(e.message),
  );
});

test('validateCouncilModels: same-family models produce a warning, different families none', () => {
  const sameFamily = validateCouncilModels([
    { handle: 'openai-codex/gpt-5.5' },
    { handle: 'openai-codex/gpt-5.6' },
  ]);
  assert.match(sameFamily.join('\n'), /same family/);

  const mixed = validateCouncilModels([
    { handle: 'openai-codex/gpt-5.5' },
    { handle: 'anthropic/claude-sonnet-4-6' },
    { handle: 'opencode/opencode/deepseek-v4-flash-free' },
  ]);
  assert.deepEqual(mixed, []);
});

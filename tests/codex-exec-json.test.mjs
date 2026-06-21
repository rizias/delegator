import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

const { codexExecJsonParser } = await import('../dist/parsers/codex-exec-json.js');

function ev(obj) {
  return codexExecJsonParser.parseLine(JSON.stringify(obj), 'stdout');
}

test('turn.completed usage becomes final token usage without double-counting cached input', () => {
  const events = [
    ev({ type: 'turn.started' }),
    ev({
      type: 'turn.completed',
      usage: {
        input_tokens: 20054,
        cached_input_tokens: 4992,
        output_tokens: 69,
        reasoning_output_tokens: 62,
      },
    }),
  ];

  assert.deepEqual(codexExecJsonParser.finalUsage(events), {
    tokens: { input: 20054, output: 69, total: 20123, reasoning: 62 },
    iterations: 1,
  });
});

test('agent_message is the final summary and item-level errors are non-fatal noise', () => {
  const events = [
    ev({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'plugin warning' } }),
    ev({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'DONE' } }),
  ];

  assert.equal(events[0].kind, 'noise');
  assert.equal(events[1].kind, 'output');
  assert.equal(codexExecJsonParser.finalSummary('', events), 'DONE');
});

test('turn.failed and stream-level error are real error events', () => {
  assert.equal(ev({ type: 'turn.failed', error: { message: 'boom' } }).kind, 'error');
  assert.equal(ev({ type: 'error', message: 'stream broke' }).kind, 'error');
});

test('assessSandbox allows relative file_change paths inside the worktree', () => {
  const worktree = path.join(os.tmpdir(), 'dlg-codex-json-worktree');
  const events = [
    ev({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: 'src/index.ts', kind: 'update' }], status: 'completed' } }),
  ];

  assert.deepEqual(codexExecJsonParser.assessSandbox(events, worktree), { confined: true });
});

test('assessSandbox rejects absolute file_change paths outside the worktree', () => {
  const worktree = path.join(os.tmpdir(), 'dlg-codex-json-worktree');
  const outside = path.join(os.tmpdir(), 'dlg-codex-json-outside.txt');
  const events = [
    ev({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: outside, kind: 'add' }], status: 'completed' } }),
  ];

  const result = codexExecJsonParser.assessSandbox(events, worktree);
  assert.equal(result.confined, false);
  assert.match(result.detail, /codex wrote outside the worktree:/);
  assert.match(result.detail, /dlg-codex-json-outside\.txt/);
});

test('assessSandbox rejects Windows-style absolute paths outside the worktree on Windows', { skip: process.platform !== 'win32' }, () => {
  const worktree = 'C:\\work\\repo';
  const events = [
    ev({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: 'D:\\escape\\out.txt', kind: 'add' }], status: 'completed' } }),
  ];

  const result = codexExecJsonParser.assessSandbox(events, worktree);
  assert.equal(result.confined, false);
  assert.match(result.detail, /D:\\escape\\out\.txt/);
});

test('assessSandbox catches an outside path even when the file_change line exceeds the 4000-char raw cap', () => {
  const worktree = path.join(os.tmpdir(), 'dlg-codex-json-worktree');
  const outside = path.join(os.tmpdir(), 'dlg-codex-json-escape.txt');
  const padding = 'x'.repeat(5000); // push the serialized line past the 4000-char raw truncation
  const event = ev({
    type: 'item.completed',
    item: { id: 'item_1', type: 'file_change', status: 'completed', note: padding, changes: [{ path: outside, kind: 'add' }] },
  });
  assert.ok(event.raw.length <= 4000, 'precondition: raw is truncated, so re-parsing it would fail');
  const result = codexExecJsonParser.assessSandbox([event], worktree);
  assert.equal(result.confined, false, 'a long file_change must NOT slip past the escape guard');
  assert.match(result.detail, /dlg-codex-json-escape\.txt/);
});

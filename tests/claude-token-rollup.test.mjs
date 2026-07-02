import test from 'node:test';
import assert from 'node:assert/strict';

const { claudeStreamJsonParser: p } = await import('../dist/parsers/claude-stream-json.js');

// A claude `result` line carries `usage` AFTER a potentially-huge `result` text. When the answer is
// long (multi-turn / big review), the JSON line exceeds the 4000-char cap that parseLine applies to
// the stored `raw`, so re-parsing `raw` later loses the trailing `usage`. Tokens must still roll up.
const longAnswer = '## VERDICT\n' + 'x'.repeat(5000);
const resultLine = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  result: longAnswer,
  usage: { input_tokens: 29429, output_tokens: 5072 },
});

test('claude parseLine parses tokens from the FULL result line (not the truncated raw)', () => {
  assert.ok(resultLine.length > 4000, 'result line must be long enough to truncate');
  const ev = p.parseLine(resultLine, 'stdout');
  assert.equal(ev.kind, 'result');
  assert.ok(ev.raw.length <= 4000, 'stored raw is truncated to 4000');
  assert.equal(ev.tokens?.input, 29429);
  assert.equal(ev.tokens?.output, 5072);
  assert.equal(ev.tokens?.total, 34501);
});

test('claude finalUsage rolls up tokens even when result raw is truncated (regression: token-rollup bug)', () => {
  const ev = p.parseLine(resultLine, 'stdout');
  const usage = p.finalUsage([ev]);
  // Before the fix this returned {} because finalUsage re-parsed the truncated raw (invalid JSON).
  assert.ok(usage.tokens, 'usage.tokens must be present');
  assert.equal(usage.tokens.input, 29429);
  assert.equal(usage.tokens.output, 5072);
  assert.equal(usage.tokens.total, 34501);
});

test('claude finalUsage still surfaces tokens for a SHORT result line (no truncation)', () => {
  const shortLine = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    result: 'ok', usage: { input_tokens: 100, output_tokens: 20 },
  });
  const ev = p.parseLine(shortLine, 'stdout');
  const usage = p.finalUsage([ev]);
  assert.equal(usage.tokens?.total, 120);
  assert.equal(usage.iterations, 1); // num_turns survives when raw isn't truncated
});

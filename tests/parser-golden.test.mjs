// Golden fixtures: a real "1 + 1" run captured from each harness's own CLI, reduced to a minimal
// clean sample. Each fixture is a VERBATIM event stream from a live run (answer normalized to "2"),
// with only the following removed/redacted:
//   - the model's reasoning/thinking payloads and streaming deltas (e.g. pi's encrypted
//     thinkingSignature, message_update chunks) — the "reasoning noise",
//   - environment-injected lines a clean delegator worker never emits (claude hook_started/
//     hook_response, codex plugin/skill config errors, rate_limit_event),
//   - private identifiers (session/thread/request ids, paths) -> "REDACTED".
// Token usage is kept VERBATIM from the real run, so this locks the real per-CLI usage shape:
//   claude   -> --output-format stream-json : assistant + result{result,usage.input_tokens/output_tokens,num_turns}
//   codex    -> exec --json                 : item.completed{agent_message} + turn.completed{usage.input_tokens/output_tokens/reasoning_output_tokens}
//   opencode -> run --format json           : step_start / text part / step_finish{part.tokens{input,output,reasoning,total}}
//   pi       -> --print --mode json         : turn_start / message_end{message.role:assistant, usage{input,output,totalTokens}}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { claudeStreamJsonParser } from '../dist/parsers/claude-stream-json.js';
import { codexExecJsonParser } from '../dist/parsers/codex-exec-json.js';
import { opencodeNdjsonParser } from '../dist/parsers/opencode-ndjson.js';
import { piNdjsonParser } from '../dist/parsers/pi-ndjson.js';

function runFixture(parser, file) {
  const text = fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
  const events = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => parser.parseLine(l, 'stdout'));
  return { summary: parser.finalSummary('', events), usage: parser.finalUsage(events) };
}

// Totals are the real captured usage (input_tokens + output_tokens for that run), so the test is a
// snapshot: regenerate the fixture and these numbers move with it.
const CASES = [
  { name: 'claude', parser: claudeStreamJsonParser, file: 'claude.jsonl', total: 18283, iterations: 1 },
  { name: 'codex', parser: codexExecJsonParser, file: 'codex.jsonl', total: 22645, iterations: 1 },
  { name: 'opencode', parser: opencodeNdjsonParser, file: 'opencode.jsonl', total: 20222, iterations: 1 },
  { name: 'pi', parser: piNdjsonParser, file: 'pi.jsonl', total: 5692, iterations: 1 },
];

for (const c of CASES) {
  test(`golden: ${c.name} real "1 + 1" run maps to summary "2" and correct usage`, () => {
    const { summary, usage } = runFixture(c.parser, c.file);
    assert.equal(summary.trim(), '2', `${c.name}: final summary is the answer "2"`);
    assert.equal(usage.iterations, c.iterations, `${c.name}: iteration count`);
    assert.equal(usage.tokens?.total, c.total, `${c.name}: total token usage`);
  });
}

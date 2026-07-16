// Regressions: iteration counting and model pinning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { descriptorToAdapter } from '../dist/runtimes/factory.js';
import { mergedRuntimeDescriptors } from '../dist/config.js';
import { failureText } from '../dist/runner.js';
import { classifyFailure } from '../dist/classify.js';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-claude-runtime-'));
const claudeRuntime = descriptorToAdapter('claude', mergedRuntimeDescriptors({}).claude);

test('top-level assistant message counts as a turn', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [] } });
  const ev = claudeRuntime.parseLine(line, 'stdout');
  assert.equal(ev.kind, 'turn');
});

test('sub-agent assistant message (parent_tool_use_id) does NOT count as a turn', () => {
  const line = JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_123', message: { content: [] } });
  const ev = claudeRuntime.parseLine(line, 'stdout');
  assert.equal(ev.kind, 'output');
});

test('a synthetic claude message is noise, not a turn (locally injected CLI notice, no provider round-trip)', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'You are not authorized. 403 Forbidden.' }] },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const ev = claudeRuntime.parseLine(line, 'stdout');
  assert.equal(ev.kind, 'noise', 'synthetic message must be noise, never a turn');
  assert.equal(ev.synthetic, true, 'synthetic flag must be set for failureText to exclude it');
});

test('failureText still scans NON-synthetic noise (codex tags error items noise — they must classify)', () => {
  // failureText must exclude ONLY synthetic events. Codex marks its error items and some stderr
  // as 'noise', and those are exactly where its provider errors (429/5xx) surface — filtering
  // all noise would silently kill codex failure classification (retry/fallover/breaker).
  const codexNoise = { ts: 1, stream: 'stdout', kind: 'noise', raw: '{"type":"item.completed","item":{"item_type":"error","message":"429 too many requests"}}' };
  assert.equal(classifyFailure(failureText([codexNoise]))?.class, 'rate-limit', 'non-synthetic noise must still classify');
});

test('a synthetic notice still surfaces in finalSummary when it is the only explanation', () => {
  // The notice is excluded from turns and classification, but it is often the ONE human-readable
  // line saying why claude stopped (usage limit, permission, interrupt) — the summary must keep it.
  const notice = claudeRuntime.parseLine(JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Usage limit reached.' }] },
  }), 'stdout');
  const errResult = claudeRuntime.parseLine(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution' }), 'stdout');
  assert.match(claudeRuntime.finalSummary('', [notice, errResult]), /Usage limit reached\./, 'error summary must carry the notice');
  assert.match(claudeRuntime.finalSummary('', [notice]), /Usage limit reached\./, 'no-result fallback must carry the notice');
});

test('a synthetic auth-looking notice does NOT classify as a provider failure (no false breaker trip)', () => {
  // Regression: a `<synthetic>` notice carrying "unauthorized/401" once matched AUTH_RE and opened
  // the circuit breaker for 10 min on the main subscription worker — from a message that never hit
  // the API. failureText must drop it (it is 'noise'), so classifyFailure sees nothing provider-shaped.
  const synthetic = claudeRuntime.parseLine(JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'unauthorized: 401' }] },
    usage: { input_tokens: 0, output_tokens: 0 },
  }), 'stdout');
  assert.equal(classifyFailure(failureText([synthetic])), null, 'synthetic notice must not trip auth');

  // Control: a genuine (non-synthetic) 401 still classifies as auth — the fix scopes to synthetic only.
  const real = claudeRuntime.parseLine(JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'authentication_error: 401' }] },
  }), 'stdout');
  assert.equal(classifyFailure(failureText([real]))?.class, 'auth', 'a genuine 401 still classifies as auth');
});

test('result event carries token usage', () => {
  const line = JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } });
  const ev = claudeRuntime.parseLine(line, 'stdout');
  assert.equal(ev.kind, 'result');
  assert.equal(ev.tokens.total, 15);
});

test('claude result subtype is not reclassified as a partial exit', () => {
  const event = claudeRuntime.parseLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }), 'stdout');
  assert.equal(claudeRuntime.classifyExit?.(1, [event]) ?? null, null);
});

test('long final message survives the 4000-char raw truncation (summary not lost/garbled)', () => {
  // A long final answer: each stream line exceeds 4000 chars. `raw` is truncated for the
  // log, so re-parsing it throws — the old summary fell back to dumping clipped raw JSON
  // (or returned nothing). The fix captures the text at parse time from the FULL line.
  const longText = 'CONCLUSION: ' + 'x'.repeat(6000);
  const asstLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } });
  const resultLine = JSON.stringify({ type: 'result', result: longText, usage: { input_tokens: 1, output_tokens: 1 } });
  assert.ok(asstLine.length > 4000 && resultLine.length > 4000, 'precondition: lines exceed the 4000 truncation');

  const asst = claudeRuntime.parseLine(asstLine, 'stdout');
  const result = claudeRuntime.parseLine(resultLine, 'stdout');
  assert.ok(asst.raw.length <= 4000, 'raw is truncated for the log');
  assert.ok(asst.text && asst.text.length > 4000, 'full text is captured at parse time');

  const summary = claudeRuntime.finalSummary('', [asst, result]);
  assert.ok(summary.startsWith('CONCLUSION:'), 'the real final message is the summary, not garbled JSON');
  assert.ok(summary.length > 1500, 'more than the old 1500-char clip survives');
});

test('finalSummary returns the result field from a truncated result event (no assistant fallback)', () => {
  // The `result` line carries the authoritative final answer in its `result` field. For a long
  // answer the stored raw is truncated to 4000 chars -> invalid JSON, so re-parsing raw threw and
  // the real answer was silently dropped in favour of the fallback. The fix captures the result
  // text at parse time from the FULL line (mirrors the token capture in parseLine).
  const answer = 'FINAL ANSWER: ' + 'y'.repeat(6000);
  const resultLine = JSON.stringify({ type: 'result', num_turns: 3, result: answer, usage: { input_tokens: 1, output_tokens: 1 } });
  assert.ok(resultLine.length > 4000, 'precondition: the result line exceeds the 4000-char truncation');

  const ev = claudeRuntime.parseLine(resultLine, 'stdout');
  assert.ok(ev.raw.length <= 4000, 'raw is truncated for the log (would be invalid JSON)');

  // Only the result event is present — there is NO assistant turn to fall back to. If finalSummary
  // re-parsed raw it would throw and return the (empty) stdout tail instead of the real answer.
  const summary = claudeRuntime.finalSummary('', [ev]);
  assert.equal(summary, answer, 'the exact result field is returned, not the fallback');
});

test('finalSummary reports the claude stop diagnostic from a truncated error result event', () => {
  // Error result lines can also exceed 4000 chars. is_error/subtype/errors must survive the raw
  // truncation too — otherwise a long-running run that hits an error loses its diagnosis.
  const resultLine = JSON.stringify({
    type: 'result', is_error: true, subtype: 'error_max_turns', errors: ['boom'],
    session_id: 'z'.repeat(6000), // filler so the line exceeds the 4000-char truncation
  });
  assert.ok(resultLine.length > 4000, 'precondition: the error result line exceeds the truncation');

  const ev = claudeRuntime.parseLine(resultLine, 'stdout');
  assert.ok(ev.raw.length <= 4000, 'raw is truncated for the log');

  const summary = claudeRuntime.finalSummary('', [ev]);
  assert.match(summary, /^claude stopped: error_max_turns/, 'stop diagnostic built from captured fields, not re-parsed raw');
  assert.match(summary, /boom/, 'the errors detail survives truncation');
});

test('finalUsage reads captured tokens/iterations from a truncated result event (not re-parsed raw)', () => {
  // Same latent bug as finalSummary: finalUsage re-parsed the truncated raw for usage + num_turns.
  // On a long answer that JSON.parse throws and both token usage AND the iteration count are lost.
  const answer = 'x'.repeat(6000);
  const resultLine = JSON.stringify({ type: 'result', num_turns: 2, result: answer, usage: { input_tokens: 10, output_tokens: 5 } });
  assert.ok(resultLine.length > 4000, 'precondition: the result line exceeds the 4000-char truncation');

  const ev = claudeRuntime.parseLine(resultLine, 'stdout');
  assert.ok(ev.raw.length <= 4000, 'raw is truncated for the log (would be invalid JSON)');

  const usage = claudeRuntime.finalUsage([ev]);
  assert.equal(usage.tokens?.total, 15, 'token usage survives the truncation');
  assert.equal(usage.iterations, 2, 'num_turns survives the truncation');
});

function ctxFor(kind, model) {
  return {
    brief: 'b', worktree: 'wt',
    budget: { wallClockMs: 1000 },
    resolved: {
      workerId: 'w', providerId: 'p',
      worker: { provider: 'p', model, runtime: 'claude-headless' },
      provider: { kind, baseUrl: 'https://x.example/anthropic' },
      apiKey: 'k',
    },
  };
}

function tempWorktree() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-claude-equip-'));
  const worktree = path.join(runRoot, 'worktree');
  fs.mkdirSync(worktree);
  return worktree;
}

test('anthropic-compatible providers get every model alias pinned', () => {
  const spec = claudeRuntime.buildSpawn(ctxFor('anthropic-compatible', 'glm-5-turbo'));
  // Without pinning, haiku-alias calls were served by glm-4.5-air.
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    assert.equal(spec.env[k], 'glm-5-turbo', k);
  }
});

test('workers cannot spawn sub-workers (Task tool disallowed)', () => {
  const spec = claudeRuntime.buildSpawn(ctxFor('anthropic-compatible', 'glm-5-turbo'));
  const i = spec.args.indexOf('--disallowedTools');
  assert.notEqual(i, -1);
  assert.equal(spec.args[i + 1], 'Task');
});

test('brief travels via stdin, never argv', () => {
  const spec = claudeRuntime.buildSpawn(ctxFor('anthropic-compatible', 'glm-5-turbo'));
  assert.equal(spec.stdinData, 'b');
  assert.ok(!spec.args.includes('b'));
});

test('headless workers run bypassPermissions (acceptEdits denied every Bash call, burning the budget)', () => {
  const spec = claudeRuntime.buildSpawn(ctxFor('anthropic-compatible', 'glm-5-turbo'));
  const i = spec.args.indexOf('--permission-mode');
  assert.notEqual(i, -1);
  assert.equal(spec.args[i + 1], 'bypassPermissions');
  assert.ok(!spec.args.includes('acceptEdits'), 'acceptEdits blocks Bash in headless — must not be used');
});

test('worktree-isolation reminder is appended to the system prompt (worker wrote to the real repo via absolute paths)', () => {
  const spec = claudeRuntime.buildSpawn(ctxFor('anthropic-compatible', 'glm-5-turbo'));
  const i = spec.args.indexOf('--append-system-prompt');
  assert.notEqual(i, -1);
  const prompt = spec.args[i + 1];
  assert.ok(prompt.includes('wt'), 'reminder must name the worktree path (cwd)');
  assert.match(prompt, /never write outside/i);
});

test('extraArgs are appended verbatim to the claude argv (escape hatch works on every runtime)', () => {
  const ctx = ctxFor('anthropic-compatible', 'glm-5-turbo');
  ctx.resolved.worker.extraArgs = ['--mcp-config', '.mcp.json'];
  const spec = claudeRuntime.buildSpawn(ctx);
  const i = spec.args.indexOf('--mcp-config');
  assert.notEqual(i, -1, 'extraArgs must reach argv (claude-headless silently dropped it before this fix)');
  assert.equal(spec.args[i + 1], '.mcp.json', 'the value follows the flag, in order');
});

test('equip.profile clean gives claude a throwaway config dir under the run area', () => {
  const ctx = ctxFor('anthropic-compatible', 'glm-5-turbo');
  ctx.worktree = tempWorktree();
  ctx.resolved.worker.equip = { profile: 'clean' };
  const spec = claudeRuntime.buildSpawn(ctx);
  assert.ok(spec.env.CLAUDE_CONFIG_DIR, 'clean profile must set CLAUDE_CONFIG_DIR');
  assert.ok(fs.existsSync(spec.env.CLAUDE_CONFIG_DIR), 'throwaway config dir must exist before spawn');
  assert.ok(spec.env.CLAUDE_CONFIG_DIR.startsWith(path.dirname(ctx.worktree) + path.sep));
});

test('equip.profile inherit and absent preserve claude host-profile inheritance', () => {
  const inheritCtx = ctxFor('anthropic-compatible', 'glm-5-turbo');
  inheritCtx.resolved.worker.equip = { profile: 'inherit' };
  assert.equal(claudeRuntime.buildSpawn(inheritCtx).env.CLAUDE_CONFIG_DIR, undefined);

  const absentCtx = ctxFor('anthropic-compatible', 'glm-5-turbo');
  assert.equal(claudeRuntime.buildSpawn(absentCtx).env.CLAUDE_CONFIG_DIR, undefined);
});

test('equip.tools drives claude allowedTools and takes precedence over tier tools', () => {
  const ctx = ctxFor('anthropic-compatible', 'glm-5-turbo');
  ctx.tier = { chain: ['w'], fallback: 'report', tools: ['Read'] };
  ctx.resolved.worker.equip = { tools: ['Read', 'Edit', 'Bash'] };
  const spec = claudeRuntime.buildSpawn(ctx);
  const i = spec.args.indexOf('--allowedTools');
  assert.notEqual(i, -1);
  assert.equal(spec.args[i + 1], 'Read,Edit,Bash');
});

// The env fix is descriptor-driven (authEnv), not hardcoded — so
// any login-based CLI gets the same protection just by declaring its namespace. Gated on auth mode.
test('subscription worker preserves the runtime-declared authEnv login namespace', () => {
  const ctx = ctxFor('anthropic', 'claude-opus-4-8');
  ctx.resolved.provider.auth = 'subscription';
  const spec = claudeRuntime.buildSpawn(ctx);
  // claude's descriptor declares authEnv: [ANTHROPIC, CLAUDE]; both must reach preserveEnv.
  assert.ok(spec.preserveEnv?.includes('ANTHROPIC'), 'subscription must preserve the ANTHROPIC login namespace');
  assert.ok(spec.preserveEnv?.includes('CLAUDE'), 'subscription must preserve the CLAUDE login namespace');
});

test('api-key worker on the claude runtime does NOT preserve host auth env (no cross-provider leak)', () => {
  // e.g. z.ai/GLM on the claude runtime: its key arrives via spec.env, so the host Claude login
  // must stay stripped — otherwise the user's Claude token would leak into a z.ai worker.
  const ctx = ctxFor('anthropic-compatible', 'glm-5-turbo');
  ctx.resolved.provider.auth = 'api-key';
  const spec = claudeRuntime.buildSpawn(ctx);
  assert.ok(!spec.preserveEnv || spec.preserveEnv.length === 0, 'api-key worker keeps the host stripped');
});

// When the host is logged into Claude Code, the OAuth in ~/.claude shadows the injected
// ANTHROPIC_AUTH_TOKEN and the CLI authenticates as the subscription -> 401 against an api-key
// endpoint. An api-key claude worker must therefore run with an isolated config dir.
test('an api-key claude worker gets an isolated CLAUDE_CONFIG_DIR (host OAuth must not shadow its key)', () => {
  const ctx = ctxFor('anthropic-compatible', 'glm-5.2');
  ctx.worktree = tempWorktree();
  ctx.resolved.provider.auth = 'api-key';
  const spec = claudeRuntime.buildSpawn(ctx);
  assert.ok(spec.env.CLAUDE_CONFIG_DIR, 'api-key worker must use a clean CLAUDE_CONFIG_DIR');
  assert.ok(fs.existsSync(spec.env.CLAUDE_CONFIG_DIR));
});

test('a subscription claude worker still inherits the host profile (it NEEDS that login)', () => {
  const ctx = ctxFor('anthropic', 'claude-opus-4-8');
  ctx.worktree = tempWorktree();
  ctx.resolved.provider.auth = 'subscription';
  const spec = claudeRuntime.buildSpawn(ctx);
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, undefined, 'subscription must inherit ~/.claude, not isolate');
});

test('explicit equip.profile inherit overrides the api-key clean default', () => {
  const ctx = ctxFor('anthropic-compatible', 'glm-5.2');
  ctx.worktree = tempWorktree();
  ctx.resolved.provider.auth = 'api-key';
  ctx.resolved.worker.equip = { profile: 'inherit' };
  const spec = claudeRuntime.buildSpawn(ctx);
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, undefined, 'an explicit inherit profile must win');
});

// api-oneshot runtime: a NON-AGENTIC in-process runtime that does ONE OpenAI Chat
// Completions POST and returns the text. Request building + response parsing are PURE;
// the live fetch is INJECTED (opts.fetchImpl), so none of these tests need a server.
// Covers: request URL/headers (with a key AND localhost without a key), body shape,
// response parsing (content + tokens), and error handling (reachability, 429/401/5xx,
// timeout, bad/empty body). Plus one executeRun wiring test proving the in-process
// branch yields a completed envelope with empty changes + the model's reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-oneshot-'));

const { buildDirectApiRequest, directApiRuntimeFromDescriptor } = await import('../dist/runtimes/direct_api.js');
const { openaiChatParser } = await import('../dist/parsers/openai-chat.js');
const { executeRun } = await import('../dist/runner.js');

const apiDescriptor = {
  mode: 'direct-api',
  protocol: 'openai',
  auth: ['api-key', 'none'],
  request: {
    method: 'POST',
    path: '/chat/completions',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Bearer {{secret(provider.id)}}',
    },
    json: {
      model: '{{model.id}}',
      messages: [{ role: 'user', content: '{{brief}}' }],
      stream: false,
    },
  },
  output: { parser: 'builtin:openai-chat' },
};

const buildRequest = (c) => buildDirectApiRequest('api', apiDescriptor, c);
const parseResponse = (json) => openaiChatParser.parse(json);
const apiOneshotRuntime = directApiRuntimeFromDescriptor('api', apiDescriptor);

// ---- ctx helper (a RuntimeContext for an openai-compatible worker) ----
function ctx(overrides = {}) {
  const {
    apiKey = 'secret-key',
    baseUrl = 'https://api.example.com/v1', model = 'gpt-x',
    brief = 'Answer in one short sentence: what is 2+2?',
  } = overrides;
  const resolved = {
    workerId: 'w', providerId: 'p',
    worker: { provider: 'p', model, runtime: 'api' },
    provider: { kind: 'openai-compatible', baseUrl },
  };
  if (apiKey !== undefined) resolved.apiKey = apiKey;
  return { brief, worktree: '', budget: { wallClockMs: 5000 }, resolved };
}

// ===================== buildRequest (pure) =====================

test('buildRequest: URL appends /chat/completions to the /v1 baseUrl', () => {
  const r = buildRequest(ctx({ baseUrl: 'https://api.example.com/v1' }));
  assert.equal(r.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(r.method, 'POST');
});

test('buildRequest: trailing slashes on baseUrl are collapsed', () => {
  const r = buildRequest(ctx({ baseUrl: 'https://api.example.com/v1///' }));
  assert.equal(r.url, 'https://api.example.com/v1/chat/completions');
});

test('buildRequest WITH a key sends Authorization: Bearer <key>', () => {
  const r = buildRequest(ctx({ apiKey: 'sk-test-123' }));
  assert.equal(r.headers['authorization'], 'Bearer sk-test-123');
  assert.equal(r.headers['content-type'], 'application/json');
});

test('buildRequest localhost WITHOUT a key sends NO Authorization header', () => {
  const r = buildRequest(ctx({ apiKey: undefined, baseUrl: 'http://localhost:1234/v1' }));
  assert.equal(r.headers['authorization'], undefined, 'a local provider must send no auth');
  assert.match(r.url, /localhost:1234\/v1\/chat\/completions$/);
});

test('buildRequest: body is the OpenAI Chat Completions shape (model + one user message + stream:false)', () => {
  const r = buildRequest(ctx({ model: 'qwen2.5-coder', brief: 'hello' }));
  const body = JSON.parse(r.body);
  assert.equal(body.model, 'qwen2.5-coder');
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});

// ===================== parseResponse (pure) =====================

test('parseResponse: extracts content + token usage (prompt/completion/total)', () => {
  const { summary, tokens } = parseResponse({
    choices: [{ message: { content: 'The answer is 4.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(summary, 'The answer is 4.');
  assert.equal(tokens.input, 10);
  assert.equal(tokens.output, 5);
  assert.equal(tokens.total, 15);
});

test('parseResponse: captures OpenAI reasoning_tokens without subtracting them from completion_tokens', () => {
  const { tokens } = parseResponse({
    choices: [{ message: { content: 'ok' } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 220,
      total_tokens: 320,
      completion_tokens_details: { reasoning_tokens: 200 },
    },
  });
  assert.equal(tokens.input, 100);
  assert.equal(tokens.output, 220);
  assert.equal(tokens.reasoning, 200);
  assert.equal(tokens.total, 320);
});

test('parseResponse: computes total when the server omits it', () => {
  const { tokens } = parseResponse({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });
  assert.equal(tokens.total, 10);
});

test('parseResponse: trims whitespace and yields empty summary for blank content', () => {
  assert.equal(parseResponse({ choices: [{ message: { content: '  x  ' } }] }).summary, 'x');
  assert.equal(parseResponse({ choices: [{ message: { content: '   ' } }] }).summary, '');
  assert.equal(parseResponse({ choices: [] }).summary, '');
});

test('parseResponse: no usage block -> no tokens', () => {
  const { summary, tokens } = parseResponse({ choices: [{ message: { content: 'ok' } }] });
  assert.equal(summary, 'ok');
  assert.equal(tokens, undefined);
});

// ===================== execute (injected fetch) =====================

test('execute: 2xx -> completed, summary is the reply, tokens carried; auth + body sent correctly', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, headers: { ...opts.headers }, body: opts.body };
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: '4' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
    };
  };
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'sk-live' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'completed');
  assert.equal(res.summary, '4');
  assert.equal(res.tokens.total, 4);
  assert.equal(res.failure, null);
  // The request the runtime actually sent:
  assert.equal(captured.headers['authorization'], 'Bearer sk-live');
  assert.deepEqual(JSON.parse(captured.body).messages, [{ role: 'user', content: 'Answer in one short sentence: what is 2+2?' }]);
});

test('execute: localhost call sends no Authorization header', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { headers: { ...opts.headers } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await apiOneshotRuntime.execute(ctx({ apiKey: undefined, baseUrl: 'http://localhost:1234/v1' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(captured.headers['authorization'], undefined);
});

test('execute: connection error -> failed, "could not reach", server failure (eligible for fallover)', async () => {
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234'); };
  const res = await apiOneshotRuntime.execute(
    ctx({ apiKey: undefined, baseUrl: 'http://localhost:1234/v1' }),
    { timeoutMs: 5000, fetchImpl },
  );
  assert.equal(res.status, 'failed');
  assert.match(res.summary, /could not reach http:\/\/localhost:1234/);
  assert.match(res.summary, /ECONNREFUSED/);
  assert.equal(res.failure.class, 'server');
  assert.equal(res.failure.errType, 'server');
  assert.equal(res.errType, 'server');
});

test('execute: HTTP 429 -> rate-limit failure with Retry-After honored', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 429,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '30' : null) },
    text: async () => '{"error":"rate limited"}',
  });
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'k' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'failed');
  assert.equal(res.failure.class, 'rate-limit');
  assert.equal(res.failure.errType, 'rate-limit');
  assert.equal(res.failure.retryAfterMs, 30_000, 'retry-after: 30 (seconds) -> 30000ms');
});

test('execute: HTTP 401 -> auth failure', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 401, headers: { get: () => null },
    text: async () => '{"error":{"code":"invalid_api_key"}}',
  });
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'bad' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'failed');
  assert.equal(res.failure.class, 'auth');
  assert.equal(res.failure.errType, 'auth');
});

test('execute: HTTP 503 -> server failure', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 503, headers: { get: () => null },
    text: async () => 'service unavailable',
  });
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'k' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.failure.class, 'server');
});

test('execute: timeout (abort) -> failed, errType timeout, NOT a provider failure', async () => {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  const fetchImpl = async () => { throw e; };
  const res = await apiOneshotRuntime.execute(
    ctx({ apiKey: undefined, baseUrl: 'http://localhost:1234/v1' }),
    { timeoutMs: 5000, fetchImpl },
  );
  assert.equal(res.status, 'failed');
  assert.equal(res.errType, 'timeout');
  assert.equal(res.failure, null, 'a budget timeout must not blame the provider / breaker');
  assert.match(res.summary, /timed out/);
});

test('execute: HTTP 400 (request/config error) -> failed but NOT a provider failure (no fallover)', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 400, headers: { get: () => null },
    text: async () => '{"error":{"message":"model not found"}}',
  });
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'k' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'failed');
  assert.equal(res.failure, null, 'a 400 is a request error, not a provider outage');
  assert.match(res.summary, /HTTP 400/);
});

test('execute: 2xx with empty content -> failed (clear, not a silent empty success)', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  });
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'k' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'failed');
  assert.equal(res.failure, null);
  assert.match(res.summary, /empty reply/);
});

test('execute: 2xx with unparseable body -> failed', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => { throw new Error('Unexpected token < in JSON'); },
  });
  const res = await apiOneshotRuntime.execute(ctx({ apiKey: 'k' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'failed');
  assert.match(res.summary, /could not parse/);
});

// ===================== executeRun wiring (in-process branch) =====================

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

function baseConfig() {
  return {
    version: 1,
    defaults: {
      policy: 'review',
      budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: 50, queueTimeoutSeconds: 5, queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 0, server: 0 },
      breaker: { failures: 3, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: {
      lmstudio: { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'http://localhost:1234/v1' },
    },
    workers: {
      'lmstudio-oneshot': { provider: 'lmstudio', model: 'local-model', runtime: 'api' },
    },
    tiers: {},
  };
}

test('executeRun: an api-oneshot worker returns the reply with EMPTY changes (in-process branch, no worktree)', async () => {
  const repo = makeRepo();
  const fakeRuntime = {
    id: 'api',
    execute: async () => ({
      status: 'completed',
      summary: 'The answer is 4.',
      stopReason: 'api-oneshot: single completion call succeeded',
      errType: 'server',
      tokens: { input: 5, output: 3, total: 8 },
      failure: null,
    }),
  };
  const env = await executeRun(
    { workerId: 'lmstudio-oneshot', brief: 'Answer in one short sentence: what is 2+2?', cwd: repo, policy: 'review', budgetOverride: { wallClockMs: 5000 } },
    baseConfig(),
    { api: fakeRuntime },
  );
  assert.equal(env.status, 'completed');
  assert.equal(env.runtime, 'api');
  assert.equal(env.summary, 'The answer is 4.');
  assert.deepEqual(env.changes.filesTouched, [], 'a non-agentic run produces no diff');
  assert.equal(env.changes.diffStat, '');
  assert.equal(env.changes.applied, false);
  assert.equal(env.usage.tokens.total, 8);
  assert.equal(env.usage.iterations, 1);
});

test('executeRun: api-oneshot worker without model auto-resolves the only loaded model before the call', async () => {
  const repo = makeRepo();
  const cfg = baseConfig();
  cfg.workers['lmstudio-oneshot'] = { provider: 'lmstudio', runtime: 'api' };
  let fetchedModels = false;
  let seenModel = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchedModels = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'auto-local-model' }] }),
    };
  };
  const fakeRuntime = {
    id: 'api',
    execute: async (ctx) => {
      seenModel = ctx.resolved.worker.model;
      return {
        status: 'completed',
        summary: 'ok',
        stopReason: 'api-oneshot: single completion call succeeded',
        errType: 'server',
        failure: null,
      };
    },
  };
  try {
    const env = await executeRun(
      { workerId: 'lmstudio-oneshot', brief: 'say ok', cwd: repo, policy: 'review' },
      cfg,
      { api: fakeRuntime },
    );
    assert.equal(env.status, 'completed');
    assert.equal(fetchedModels, true);
    assert.equal(seenModel, 'auto-local-model');
    assert.equal(env.model, 'auto-local-model');
  } finally {
    globalThis.fetch = orig;
  }
});

test('executeRun: an api-oneshot worker that cannot be reached returns a clear FAILED envelope', async () => {
  const repo = makeRepo();
  const fakeRuntime = {
    id: 'api',
    execute: async (c) => ({
      status: 'failed',
      summary: `could not reach http://localhost:1234/v1: connect ECONNREFUSED`,
      stopReason: 'api-oneshot: could not reach the server',
      errType: 'server',
      failure: { class: 'server', errType: 'server', reason: 'connect ECONNREFUSED' },
    }),
  };
  const env = await executeRun(
    { workerId: 'lmstudio-oneshot', brief: 'what is 2+2?', cwd: repo, policy: 'review' },
    baseConfig(),
    { api: fakeRuntime },
  );
  assert.equal(env.status, 'failed');
  assert.match(env.summary, /could not reach/);
  assert.deepEqual(env.changes.filesTouched, []);
  assert.equal(env.errors[0].type, 'server');
});

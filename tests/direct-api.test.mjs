import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-direct-api-'));

const { buildDirectApiRequest, directApiRuntimeFromDescriptor } = await import('../dist/runtimes/direct_api.js');
const { buildRuntimeRegistry } = await import('../dist/runtimes/index.js');
const { openaiChatParser } = await import('../dist/parsers/openai-chat.js');

function ctx(overrides = {}) {
  const {
    apiKey = 'secret-key',
    baseUrl = 'https://api.example.com/v1',
    providerKind = 'openai-compatible',
    providerId = 'p',
    model = 'gpt-x',
    brief = 'Answer in one short sentence: what is 2+2?',
  } = overrides;
  const resolved = {
    workerId: 'w',
    providerId,
    worker: { provider: providerId, model, runtime: 'api' },
    provider: { kind: providerKind, baseUrl },
  };
  if (apiKey !== undefined) resolved.apiKey = apiKey;
  return { brief, worktree: '', budget: { wallClockMs: 5000 }, resolved };
}

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

function buildApiOneshotRequest(c) {
  const { provider, worker, apiKey } = c.resolved;
  const base = (provider.baseUrl ?? '').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(base)) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return {
    url: `${base}/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: worker.model,
      messages: [{ role: 'user', content: c.brief }],
      stream: false,
    }),
  };
}

test('direct-api request equals api_oneshot for keyed non-local provider', () => {
  const c = ctx({ apiKey: 'sk-test-123', baseUrl: 'https://api.example.com/v1///', brief: 'hello "json"\nline' });
  const oldReq = buildApiOneshotRequest(c);
  const newReq = buildDirectApiRequest('api', apiDescriptor, c);
  assert.deepEqual(
    { ...newReq, body: JSON.parse(newReq.body) },
    { ...oldReq, body: JSON.parse(oldReq.body) },
  );
});

test('direct-api request equals api_oneshot for local keyless provider', () => {
  const c = ctx({ apiKey: undefined, baseUrl: 'http://localhost:1234/v1' });
  const oldReq = buildApiOneshotRequest(c);
  const newReq = buildDirectApiRequest('api', apiDescriptor, c);
  assert.deepEqual(
    { ...newReq, body: JSON.parse(newReq.body) },
    { ...oldReq, body: JSON.parse(oldReq.body) },
  );
  assert.equal(newReq.headers.authorization, undefined);
  assert.equal(newReq.headers.Authorization, undefined);
});

test('builtin:openai-chat parses content and token usage', () => {
  const parsed = openaiChatParser.parse({
    choices: [{ message: { content: ' The answer is 4. ' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(parsed.summary, 'The answer is 4.');
  assert.deepEqual(parsed.tokens, { input: 10, output: 5, reasoning: undefined, total: 15 });
});

test('direct-api executor uses injected fetch and parser', async () => {
  let captured = null;
  const runtime = directApiRuntimeFromDescriptor('api', apiDescriptor);
  const fetchImpl = async (url, opts) => {
    captured = { url, method: opts.method, headers: { ...opts.headers }, body: opts.body };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: '4' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    };
  };
  const res = await runtime.execute(ctx({ apiKey: 'sk-live' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'completed');
  assert.equal(res.summary, '4');
  assert.deepEqual(res.tokens, { input: 3, output: 1, reasoning: undefined, total: 4 });
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.authorization, 'Bearer sk-live');
  assert.deepEqual(JSON.parse(captured.body), {
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'Answer in one short sentence: what is 2+2?' }],
    stream: false,
  });
});

test('direct-api executor returns an error result for non-2xx responses', async () => {
  const runtime = directApiRuntimeFromDescriptor('api', apiDescriptor);
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () => '{"error":{"message":"model not found"}}',
  });
  const res = await runtime.execute(ctx({ apiKey: 'k' }), { timeoutMs: 5000, fetchImpl });
  assert.equal(res.status, 'failed');
  assert.equal(res.failure, null);
  assert.match(res.summary, /HTTP 400/);
});

test('api runtime registry entry is in-process', () => {
  const runtime = buildRuntimeRegistry({}).api;
  assert.equal(typeof runtime.execute, 'function');
  assert.equal(runtime.buildSpawn, undefined);
});

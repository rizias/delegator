// Local providers (ollama, lmstudio, … on localhost) must NOT require
// an API key: discoverable via `dlg models <name>` with no auth, and never blocked at
// run resolution for a missing key. Running one uses the in-process `api-oneshot`
// runtime (one HTTP call, no binary) — so a local worker on an openai-compatible
// provider is AVAILABLE with no key and no CLI. Also: naming a PROVIDER where a worker
// is expected gives a fixable message (`dlg run -w lmstudio` → "lmstudio is a provider,
// not a worker").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-local-'));

const { workerInfo, resolveRunPlan, resolveCandidate, isLocalProvider } = await import('../dist/registry.js');
const { fetchProviderModels } = await import('../dist/models.js');
const { ConfigError } = await import('../dist/config.js');

// Local provider with no key; non-local openai-compatible with no key (regression guard).
function providersCfg() {
  return {
    providers: {
      lmstudio: { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'http://localhost:1234/v1' },
      ollama: { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'http://localhost:11434/v1' },
      cloud: { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'https://api.example.com/v1' },
    },
  };
}

// A full cfg shape for the run path (workerInfo / resolveRunPlan). local-worker carries
// the runtime loadConfig now infers for openai-compatible (api-oneshot); cloud-worker
// omits both runtime and key to exercise the missing-key gate (which fires before the
// runtime check).
function baseCfg() {
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
      cloud: { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'https://api.example.com/v1' },
    },
    workers: {
      'local-worker': { provider: 'lmstudio', model: 'qwen2.5-coder', runtime: 'api' },
      'cloud-worker': { provider: 'cloud', model: 'gpt-x' },
    },
    tiers: {},
  };
}

// ---- models: local needs no key ----

test('dlg models <local>: no key required, fetch is attempted with no Authorization header', async () => {
  const cfg = providersCfg();
  let captured = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured = { url, headers: { ...(opts?.headers ?? {}) } };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen2.5-coder' }, { id: 'llama-3.1' }] }) };
  };
  try {
    const r = await fetchProviderModels('lmstudio', cfg);
    assert.deepEqual(r.models, ['llama-3.1', 'qwen2.5-coder']);
    assert.ok(captured, 'fetch was called (the key gate did not short-circuit)');
    assert.match(captured.url, /localhost:1234\/v1\/models$/);
    assert.equal(captured.headers['authorization'], undefined, 'no Authorization for a local provider');
    assert.equal(captured.headers['x-api-key'], undefined, 'no x-api-key for a local provider');
  } finally {
    globalThis.fetch = orig;
  }
});

test('dlg models <local>: an unreachable server is a connection note, NOT a key error', async () => {
  const cfg = providersCfg();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234'); };
  try {
    const r = await fetchProviderModels('lmstudio', cfg);
    assert.equal(r.models.length, 0);
    assert.match(r.note, /could not reach/);
    assert.doesNotMatch(r.note, /no API key/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('dlg models <non-local>: missing key still reports the key error (regression guard)', async () => {
  const cfg = providersCfg();
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  try {
    const r = await fetchProviderModels('cloud', cfg);
    assert.equal(r.models.length, 0);
    assert.match(r.note, /no API key for "cloud"/);
    assert.equal(called, false, 'a non-local provider with no key must NOT call /models');
  } finally {
    globalThis.fetch = orig;
  }
});

test('isLocalProvider only accepts localhost loopback hosts', () => {
  assert.equal(isLocalProvider({ kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }), true);
  assert.equal(isLocalProvider({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' }), true);
  assert.equal(isLocalProvider({ kind: 'openai-compatible', baseUrl: 'http://[::1]:1234/v1' }), true);
  assert.equal(isLocalProvider({ kind: 'openai-compatible', baseUrl: 'http://0.0.0.0:1234/v1' }), false);
  assert.equal(isLocalProvider({ kind: 'openai-compatible', baseUrl: 'http://192.168.1.10:1234/v1' }), false);
  assert.equal(isLocalProvider({ kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }), false);
});

// ---- run path: local worker is not blocked for a key ----

test('local worker skips the key gate and is AVAILABLE (api-oneshot is in-process: no key, no binary)', () => {
  const info = workerInfo('local-worker', baseCfg());
  assert.equal(info.status, 'available');
  assert.equal(info.runtime, 'api');
  assert.doesNotMatch(info.reason ?? '', /API key/, 'a local worker must NOT be blocked on a missing key');
});

test('non-local openai-compatible worker without a key still requires one (regression guard)', () => {
  const info = workerInfo('cloud-worker', baseCfg());
  assert.equal(info.status, 'unconfigured');
  assert.match(info.reason, /missing API key/);
});

test('dlg providers output has no trust column', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-providers-no-trust-'));
  fs.writeFileSync(path.join(home, 'providers.yaml'), [
    'version: 1',
    'privacy: { sensitivePaths: [] }',
    'providers:',
    '  p:',
    '    kind: openai-compatible',
    '    baseUrl: http://localhost:1234/v1',
    'workers:',
    '  w:',
    '    provider: p',
    '    model: qwen',
    '    runtime: api-oneshot',
    'tiers: {}',
    '',
  ].join('\n'), 'utf8');
  const out = execFileSync(process.execPath, ['dist/cli.js', 'providers', '--cwd', home], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, DELEGATOR_HOME: home },
  });
  assert.match(out, /^w\s+available\s+api\s+qwen/m);
  assert.doesNotMatch(out, /\b(native|external-cloud|local)\b/);
});

// ---- naming a provider where a worker is expected ----

test('dlg run -w <provider>: workerInfo says "is a provider, not a worker"', () => {
  const info = workerInfo('lmstudio', baseCfg()); // lmstudio is a PROVIDER here, not a worker
  assert.equal(info.status, 'unconfigured');
  assert.match(info.reason, /"lmstudio" is a provider, not a worker/);
  assert.match(info.reason, /provider: lmstudio/);
});

test('dlg run -w <provider>: resolveRunPlan surfaces it as a thrown ConfigError', () => {
  assert.throws(
    () => resolveRunPlan(baseCfg(), { workerId: 'lmstudio' }),
    (e) => {
      assert.ok(e instanceof ConfigError, 'should be a ConfigError (exit 2)');
      assert.match(e.message, /is a provider, not a worker/);
      return true;
    },
  );
});

test('a name that is neither worker nor provider stays "not found"', () => {
  const info = workerInfo('nope', baseCfg());
  assert.equal(info.status, 'unconfigured');
  assert.match(info.reason, /worker "nope" not found/);
});

test('resolveCandidate: api-oneshot worker without model auto-resolves the only loaded model', async () => {
  const cfg = baseCfg();
  cfg.workers['local-worker'] = { provider: 'lmstudio', runtime: 'api' };
  const plan = resolveRunPlan(cfg, { workerId: 'local-worker' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'qwen2.5-coder' }] }),
  });
  try {
    const resolved = await resolveCandidate(plan.candidates[0], cfg);
    assert.equal(resolved.worker.model, 'qwen2.5-coder');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveCandidate: running model endpoint wins over pulled model list', async () => {
  const cfg = baseCfg();
  cfg.providers.ollama = { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'http://localhost:11434/v1' };
  cfg.workers['ollama-worker'] = { provider: 'ollama', runtime: 'api' };
  const plan = resolveRunPlan(cfg, { workerId: 'ollama-worker' });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: { ...(opts?.headers ?? {}) } });
    if (String(url).endsWith('/api/ps')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'gemma3:4b' }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'deepseek-coder-v2' }, { id: 'gemma3:4b' }] }),
    };
  };
  try {
    const resolved = await resolveCandidate(plan.candidates[0], cfg);
    assert.equal(resolved.worker.model, 'gemma3:4b');
    assert.deepEqual(calls.map((c) => c.url), ['http://localhost:11434/api/ps']);
    assert.equal(calls[0].headers.authorization, undefined, 'running-model discovery for local providers sends no auth');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveCandidate: empty running endpoint falls back to first pulled model', async () => {
  const cfg = baseCfg();
  cfg.providers.ollama = { kind: 'openai-compatible', auth: 'api-key', baseUrl: 'http://localhost:11434/v1' };
  cfg.workers['ollama-worker'] = { provider: 'ollama', runtime: 'api' };
  const plan = resolveRunPlan(cfg, { workerId: 'ollama-worker' });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/ps')) {
      return { ok: true, status: 200, json: async () => ({ models: [] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'deepseek-coder-v2' }, { id: 'gemma3:4b' }] }),
    };
  };
  try {
    const resolved = await resolveCandidate(plan.candidates[0], cfg);
    assert.equal(resolved.worker.model, 'deepseek-coder-v2');
    assert.deepEqual(calls, ['http://localhost:11434/api/ps', 'http://localhost:11434/v1/models']);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveCandidate: absent running endpoint falls back to first pulled model', async () => {
  const cfg = baseCfg();
  cfg.workers['local-worker'] = { provider: 'lmstudio', runtime: 'api' };
  const plan = resolveRunPlan(cfg, { workerId: 'local-worker' });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/ps')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'llama-3.1' }, { id: 'qwen2.5-coder' }] }),
    };
  };
  try {
    const resolved = await resolveCandidate(plan.candidates[0], cfg);
    assert.equal(resolved.worker.model, 'llama-3.1');
    assert.deepEqual(calls, ['http://localhost:1234/api/ps', 'http://localhost:1234/v1/models']);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveCandidate: multiple loaded models auto-selects the FIRST and runs (no error)', async () => {
  const cfg = baseCfg();
  cfg.workers['local-worker'] = { provider: 'lmstudio', runtime: 'api' };
  const plan = resolveRunPlan(cfg, { workerId: 'local-worker' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'llama-3.1' }, { id: 'qwen2.5-coder' }] }),
  });
  try {
    const resolved = await resolveCandidate(plan.candidates[0], cfg);
    assert.equal(resolved.worker.model, 'llama-3.1', 'picks the first loaded model so a local worker just runs');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveCandidate: zero loaded models fail clearly with baseUrl', async () => {
  const cfg = baseCfg();
  cfg.workers['local-worker'] = { provider: 'lmstudio', runtime: 'api' };
  const plan = resolveRunPlan(cfg, { workerId: 'local-worker' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  });
  try {
    await assert.rejects(
      () => resolveCandidate(plan.candidates[0], cfg),
      (e) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, /no running or pulled model at http:\/\/localhost:1234\/v1 — pin model: or load one/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolveCandidate: explicit model stays authoritative and skips discovery', async () => {
  const cfg = baseCfg();
  let called = false;
  const plan = resolveRunPlan(cfg, { workerId: 'local-worker' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'ignored' }] }) };
  };
  try {
    const resolved = await resolveCandidate(plan.candidates[0], cfg);
    assert.equal(resolved.worker.model, 'qwen2.5-coder');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

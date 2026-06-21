// Error classification + backoff math (ARCHITECTURE §5). Pure, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure, parseRetryAfter, backoffBase, computeBackoff,
} from '../dist/classify.js';

test('429 / rate-limit signatures classify as rate-limit', () => {
  for (const s of [
    'API Error: 429 {"type":"rate_limit_error","message":"rate limited"}',
    'Error: Too Many Requests',
    'openai error: insufficient_quota',
    'google: RESOURCE_EXHAUSTED',
    'quota exceeded for this key',
  ]) {
    const v = classifyFailure(s);
    assert.equal(v?.class, 'rate-limit', s);
    assert.equal(v?.errType, 'rate-limit');
    assert.equal(v?.transient, true);
  }
});

test('401/403 + auth error names classify as auth and are NOT transient', () => {
  for (const s of [
    'API Error: 401 {"type":"authentication_error"}',
    'HTTP 403 Forbidden',
    'invalid_api_key: the provided key is wrong',
    'Error: Unauthorized',
    'permission_error: x-api-key missing',
  ]) {
    const v = classifyFailure(s);
    assert.equal(v?.class, 'auth', s);
    assert.equal(v?.transient, false);
  }
});

test('5xx / network signatures classify as server (transient)', () => {
  for (const s of [
    'API Error: 503 Service Unavailable',
    'Internal Server Error',
    '529 {"type":"overloaded_error"}',
    'Error: ECONNREFUSED 127.0.0.1:443',
    'fetch failed: getaddrinfo ENOTFOUND api.z.ai',
    'socket hang up',
  ]) {
    const v = classifyFailure(s);
    assert.equal(v?.class, 'server', s);
    assert.equal(v?.transient, true);
  }
});

test('a genuine task/code error is NOT classified (stays a worker-crash)', () => {
  for (const s of [
    'TypeError: cannot read property foo of undefined',
    'tests failed: 3 assertions',
    'I could not find the file you mentioned',
    '',
  ]) {
    assert.equal(classifyFailure(s), null, JSON.stringify(s));
  }
});

test('rate-limit wins over a co-occurring 5xx (ordered detection)', () => {
  // A 429 body sometimes mentions a gateway; it must still read as rate-limit.
  const v = classifyFailure('429 Too Many Requests (behind gateway 502)');
  assert.equal(v?.class, 'rate-limit');
});

test('parseRetryAfter understands header, prose, and JSON-ms shapes', () => {
  assert.equal(parseRetryAfter('Retry-After: 30'), 30_000);
  assert.equal(parseRetryAfter('please try again in 2 minutes'), 120_000);
  assert.equal(parseRetryAfter('{"retry_after_ms": 4500}'), 4500);
  assert.equal(parseRetryAfter('no hint here'), undefined);
});

test('classifyFailure surfaces the parsed Retry-After', () => {
  const v = classifyFailure('429 rate_limit_error. Retry-After: 12');
  assert.equal(v?.class, 'rate-limit');
  assert.equal(v?.retryAfterMs, 12_000);
});

test('backoffBase is exponential and capped', () => {
  assert.equal(backoffBase(0), 1000);
  assert.equal(backoffBase(1), 2000);
  assert.equal(backoffBase(2), 4000);
  assert.equal(backoffBase(10), 60_000); // capped
});

test('computeBackoff stays within jitter bounds and the cap', () => {
  for (let i = 0; i < 6; i++) {
    const base = backoffBase(i);
    for (let s = 0; s < 50; s++) {
      const ms = computeBackoff(i);
      assert.ok(ms >= base * 0.5 - 1, `>=lo (i=${i}, ms=${ms})`);
      assert.ok(ms <= base * 1.5 + 1, `<=hi (i=${i}, ms=${ms})`);
      assert.ok(ms <= 60_000, 'capped');
    }
  }
});

test('computeBackoff honors an explicit Retry-After', () => {
  for (let s = 0; s < 50; s++) {
    const ms = computeBackoff(0, 10_000);
    assert.ok(ms >= 10_000, `>= retryAfter (${ms})`);
    assert.ok(ms <= 12_500, `<= retryAfter+25% (${ms})`);
  }
});

// A spawned worker must NOT inherit the host's other credentials.
import test from 'node:test';
import assert from 'node:assert/strict';

const { workerEnv } = await import('../dist/proc.js');

test('workerEnv strips credential-looking host vars but keeps system vars + the worker spec env', () => {
  process.env.ZAI_API_KEY = 'host-other-provider-secret';
  process.env.SOME_TOKEN = 'host-token';
  process.env.MY_PASSWORD = 'host-pw';
  process.env.AWS_SECRET_ACCESS_KEY = 'host-aws';
  process.env.KEEP_ME = 'not-a-credential';

  const env = workerEnv({ OPENAI_API_KEY: 'the-worker-own-key' });

  // Other providers' keys / host secrets are NOT visible to the worker.
  assert.equal(env.ZAI_API_KEY, undefined, 'another provider key must not leak');
  assert.equal(env.SOME_TOKEN, undefined, 'host token must not leak');
  assert.equal(env.MY_PASSWORD, undefined, 'host password must not leak');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, 'host AWS secret must not leak');

  // Non-credential vars stay so the worker CLI still runs and finds its own config.
  assert.equal(env.KEEP_ME, 'not-a-credential');
  assert.ok(env.PATH !== undefined || env.Path !== undefined, 'PATH is preserved');

  // The worker's OWN provider key arrives via spec.env (re-injected after stripping).
  assert.equal(env.OPENAI_API_KEY, 'the-worker-own-key');
});

// A subscription runtime authenticates via its CLI's own login, carried in host env vars in the
// runtime's own namespace. Stripping those broke native Claude subscription with 401
// preserveEnv keeps them — but ONLY that namespace.
test('preserveEnv keeps the runtime-owned auth namespace, still strips unrelated secrets', () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'the-claude-login-token';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'the-claude-oauth';
  process.env.ZAI_API_KEY = 'unrelated-other-provider-key';
  process.env.RANDOM_TOKEN = 'unrelated-host-token';

  const env = workerEnv({}, ['ANTHROPIC', 'CLAUDE']);

  // The claude worker's OWN subscription auth survives (this is its credential, not a host secret).
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'the-claude-login-token', 'claude subscription auth must survive');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'the-claude-oauth', 'claude OAuth token must survive');

  // The preserve list is namespace-scoped: it must NOT re-open the door to other secrets.
  assert.equal(env.ZAI_API_KEY, undefined, "another provider's key still must not leak");
  assert.equal(env.RANDOM_TOKEN, undefined, 'unrelated host token still stripped');
});

// Without preserveEnv (api-key / none auth), the Claude namespace is NOT special — so a z.ai worker
// never sees the user's host Claude token (its own key arrives via spec.env instead).
test('without preserveEnv the claude namespace is stripped like any credential', () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'host-claude-token';
  const env = workerEnv({ ANTHROPIC_AUTH_TOKEN: 'the-zai-key' });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'the-zai-key', 'spec.env key wins; host claude token did not leak through');
});

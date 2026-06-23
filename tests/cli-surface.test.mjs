import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve('.');

function runCli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cli-surface-'));
  return spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', DELEGATOR_HOME: home, ...env },
  });
}

test('package is publishable and both bin names point at the CLI', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, false);
  // prepublishOnly must run the full gate (build + tests), not just build, so a green
  // npm publish can't ship a failing build.
  assert.equal(pkg.scripts.prepublishOnly, 'npm test');
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.equal(pkg.bin.dlg, './dist/cli.js');
  assert.equal(pkg.bin.delegator, './dist/cli.js');
});

test('dlg update help exposes the self-update command', () => {
  const r = runCli(['update', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /self-update: npm i -g @rizias\/delegator@latest/);
});

test('doctor discovers extra runtimes and API-key environment names only', () => {
  const secret = 'sk-test-should-not-print';
  // Control ALL known key env vars so the assertions are deterministic regardless of the real machine
  // (runCli merges over process.env, so an empty string overrides a key the host actually has set).
  const r = runCli(['doctor'], {
    OPENAI_API_KEY: secret,
    ZAI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    NVIDIA_API_KEY: '',
    GEMINI_API_KEY: '',
  });
  assert.equal(r.status, 0);
  for (const bin of ['git', 'claude', 'codex', 'opencode', 'pi']) {
    assert.match(r.stdout, new RegExp(`^${bin}: `, 'm'));
  }
  assert.match(r.stdout, /^OPENAI_API_KEY: set$/m);
  assert.match(r.stdout, /^ZAI_API_KEY: not set$/m);
  assert.match(r.stdout, /^DEEPSEEK_API_KEY: not set$/m);
  assert.match(r.stdout, /^NVIDIA_API_KEY: not set$/m);
  assert.match(r.stdout, /^GEMINI_API_KEY: not set$/m);
  assert.doesNotMatch(r.stdout, new RegExp(secret));
});

test('startup version check does not break a normal json command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-version-check-'));
  fs.writeFileSync(path.join(home, 'update-check.json'), JSON.stringify({
    checkedAt: Date.now(),
    latest: '999.0.0',
  }), 'utf8');
  const out = execFileSync(process.execPath, ['dist/cli.js', 'status', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DELEGATOR_HOME: home },
  });
  assert.deepEqual(JSON.parse(out), []);
});

test('skill help distinguishes a host skill from worker runtime equipment', () => {
  const r = runCli(['skill', '--help']);
  assert.equal(r.status, 0);
  const help = r.stdout.replace(/\s+/g, ' '); // commander wraps long descriptions; normalize whitespace
  assert.match(help, /install a host skill/);
  assert.match(help, /NOT the per-worker equip\.skills CLI toggles/);
});

// The shipped codex SKILL.md must be discoverable by Codex: valid YAML frontmatter
// (name + description) or Codex never surfaces it. CRLF is normalized so the guard
// holds on Windows checkouts — a literal \n match would be brittle.
test('shipped codex adapter is a valid Codex skill (SKILL.md frontmatter)', () => {
  const text = fs.readFileSync(path.join(root, 'adapters', 'codex', 'skills', 'delegator', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /^---\n/);
  assert.match(text, /^name: delegator$/m);
  assert.match(text, /^description: .+/m);
  assert.match(text, /\n---\n/);
});

test('codex skill install copies the shipped adapter to ~/.codex/skills/delegator/SKILL.md, leaves AGENTS.md', () => {
  const adapterFile = path.join(root, 'adapters', 'codex', 'skills', 'delegator', 'SKILL.md');
  const shipped = fs.readFileSync(adapterFile, 'utf8'); // assert against the REAL shipped skill — never mutate a tracked file
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-codex-home-'));
  const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'skill', 'install', 'codex'], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', HOME: home, USERPROFILE: home, DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-codex-dlg-')) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'skills', 'delegator', 'SKILL.md'), 'utf8'), shipped);
  assert.equal(fs.existsSync(path.join(home, 'AGENTS.md')), false);
});

test('read commands accept --json and emit parseable JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-json-contract-'));
  fs.writeFileSync(path.join(home, 'providers.yaml'), [
    'version: 1',
    'defaults:',
    '  model: p/a',
    '  budget: { wallClock: 10m }',
    'privacy:',
    '  sensitivePaths: []',
    'runtimes:',
    '  api:',
    '    mode: direct-api',
    '    protocol: openai',
    '    auth: none',
    '    request: { method: POST, path: /chat/completions }',
    '    output: { parser: builtin:openai-chat }',
    'providers:',
    '  p: { protocol: openai, auth: none, models: [a] }',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'), 'utf8');

  for (const cmd of ['providers', 'doctor', 'gain', 'route']) {
    const r = spawnSync(process.execPath, ['dist/cli.js', cmd, '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', DELEGATOR_HOME: home },
    });
    assert.notEqual(r.stderr.includes("unknown option '--json'"), true, `${cmd} rejected --json`);
    assert.equal(r.status, 0, `${cmd} failed\nstderr:\n${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${cmd} did not emit JSON:\n${r.stdout}`);
  }
});

test('skill install --help lists agent-skills and no longer mentions agents-md', () => {
  const r = runCli(['skill', 'install', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /agent-skills/);
  assert.doesNotMatch(r.stdout, /agents-md/);
});

// The shipped generic skill must be a valid, host-NEUTRAL Agent Skill: any Agent Skills-compatible
// reader surfaces it from name+description, so those carry the triggers, and the body must not leak
// Claude/Codex-specific phrasing. CRLF normalized so the guard holds on Windows checkouts.
test('shipped generic adapter is a valid, host-neutral Agent Skill (SKILL.md)', () => {
  const text = fs.readFileSync(path.join(root, 'adapters', 'generic', 'skills', 'delegator', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /^---\n/);
  assert.match(text, /^name: delegator$/m);
  assert.match(text, /^description: .+/m);
  assert.match(text, /\n---\n/);
  for (const trig of ['delegator', 'delegate', 'worker', 'save tokens']) {
    assert.match(text, new RegExp(trig, 'i'), `missing trigger word "${trig}"`);
  }
  assert.match(text, /never read[^\n]*secrets\.yaml/i);
  for (const cmd of ['dlg providers', 'dlg plan', 'dlg run', 'dlg result', 'dlg apply']) {
    assert.ok(text.includes(cmd), `body missing command "${cmd}"`);
  }
  for (const leak of [/for a Codex orchestrator/, /Under a (Claude|Codex) orchestrator/, /model_reasoning_effort/, /Invoke this skill with \/delegator/]) {
    assert.doesNotMatch(text, leak, `host-specific phrasing leaked: ${leak}`);
  }
});

// Both the canonical host and the `agents-skills` alias install the same SKILL.md GLOBALLY into
// ~/.agents/skills/delegator/ and never write an AGENTS.md. HOME is sandboxed.
test('agent-skills skill install writes ~/.agents/skills/delegator/SKILL.md; agents-skills alias works', () => {
  for (const host of ['agent-skills', 'agents-skills']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-agentskills-home-'));
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'skill', 'install', host], {
      cwd: home,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', HOME: home, USERPROFILE: home, DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-agentskills-dlg-')) },
    });
    assert.equal(r.status, 0, r.stderr);
    const dest = path.join(home, '.agents', 'skills', 'delegator', 'SKILL.md');
    const installed = fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n');
    assert.match(installed, /^---\n/);
    assert.match(installed, /^name: delegator$/m);
    // a SKILL.md install must never touch AGENTS.md
    assert.equal(fs.existsSync(path.join(home, 'AGENTS.md')), false);
  }
});

test('removed agents-md host is rejected and lists the current hosts', () => {
  const r = runCli(['skill', 'install', 'agents-md']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown host "agents-md"/);
  assert.match(r.stderr, /claude-code, codex, agent-skills/);
});

test('skill show prints the generic SKILL.md, not an AGENTS.md block', () => {
  const r = runCli(['skill', 'show']);
  assert.equal(r.status, 0);
  const text = r.stdout.replace(/\r\n/g, '\n');
  assert.match(text, /^---\n/);
  assert.match(text, /^name: delegator$/m);
  assert.doesNotMatch(text, /delegator:begin/);
});

// each shipped skill carries metadata.delegator-skill-version (a full ISO-8601 UTC timestamp WITH
// time) in frontmatter, and all three host skills share ONE global stamp.
test('shipped skills carry one global ISO-8601 timestamp version', () => {
  const versions = [['claude-code'], ['codex'], ['generic']].map((seg) => {
    const text = fs.readFileSync(path.join(root, 'adapters', ...seg, 'skills', 'delegator', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const m = text.match(/^\s*delegator-skill-version:\s*["']?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)["']?\s*$/m);
    assert.ok(m, `${seg.join('/')} missing an ISO-8601 UTC timestamp version`);
    return m[1];
  });
  // one global stamp: every shipped skill must carry the SAME timestamp.
  assert.equal(new Set(versions).size, 1, `skill versions drifted: ${versions.join(', ')}`);
});

// no command, no flag: any dlg invocation silently refreshes a stale GLOBAL skill on startup
// (skipped under CI, so this test runs WITHOUT CI and sandboxes HOME).
test('startup auto-refreshes a stale installed global skill', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-auto-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-auto-dlg-')) };
  delete env.CI; // auto-update is deliberately skipped under CI
  const generic = path.join(root, 'adapters', 'generic', 'skills', 'delegator', 'SKILL.md');
  const shippedVer = fs.readFileSync(generic, 'utf8').match(/delegator-skill-version:\s*["']?([^"'\n]+)/)[1];
  // pre-stage a STALE global agent-skills install: shipped body, but an old version stamp
  const dir = path.join(home, '.agents', 'skills', 'delegator');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'SKILL.md');
  fs.writeFileSync(dest, fs.readFileSync(generic, 'utf8').replace(/delegator-skill-version:\s*["'][^"'\n]+["']/, 'delegator-skill-version: "2000-01-01T00:00:00Z"'), 'utf8');
  // any dlg invocation auto-refreshes it on startup (use doctor; it always exits 0)
  const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'doctor'], { cwd: home, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(dest, 'utf8').match(/delegator-skill-version:\s*["']?([^"'\n]+)/)[1];
  assert.equal(after, shippedVer, 'startup should have refreshed the stale skill to the shipped stamp');
});

// the skill check and the npm-version check share update-check.json; a write must MERGE one field, not
// overwrite the whole file. NOTE: this seeds a FRESH checkedAt, so the detached npm child never spawns —
// it proves the in-process merge helper, not the (accepted best-effort) cross-process timing.
test('update-check.json is merged, not overwritten', () => {
  const dlgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-merge-dlg-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-merge-home-'));
  const cache = path.join(dlgHome, 'update-check.json');
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }), 'utf8'); // pre-seed the version field
  const env = { ...process.env, HOME: home, USERPROFILE: home, DELEGATOR_HOME: dlgHome };
  delete env.CI; // let the skill check run so it writes its own field
  spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'doctor'], { cwd: home, encoding: 'utf8', env });
  const merged = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(merged.latest, '99.0.0', 'the npm-version field must survive the skill check');
  assert.ok(merged.skillCheckedVersion !== undefined, 'the skill check must add its own field');
});

// a missing stamp (no metadata.delegator-skill-version line at all) must count as stale and be refreshed.
test('startup refreshes a global skill whose version stamp is missing entirely', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-nostamp-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-nostamp-dlg-')) };
  delete env.CI;
  const generic = path.join(root, 'adapters', 'generic', 'skills', 'delegator', 'SKILL.md');
  const dir = path.join(home, '.agents', 'skills', 'delegator');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'SKILL.md');
  fs.writeFileSync(dest, fs.readFileSync(generic, 'utf8').replace(/\n\s*delegator-skill-version:[^\n]*/, ''), 'utf8'); // strip the stamp line
  assert.doesNotMatch(fs.readFileSync(dest, 'utf8'), /delegator-skill-version/);
  const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'doctor'], { cwd: home, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(dest, 'utf8'), /delegator-skill-version:/, 'a stamp-less skill must be refreshed to the shipped copy');
});

// the stamp is read ONLY from frontmatter: a stray version line in the BODY must not mask a missing
// frontmatter stamp (such a file is 'unknown' -> stale -> refreshed).
test('startup ignores a delegator-skill-version line in the body, not the frontmatter', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-bodystamp-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-bodystamp-dlg-')) };
  delete env.CI;
  const generic = path.join(root, 'adapters', 'generic', 'skills', 'delegator', 'SKILL.md');
  const shipped = fs.readFileSync(generic, 'utf8');
  const shippedVer = shipped.match(/delegator-skill-version:\s*["']?([^"'\n]+)/)[1];
  const dir = path.join(home, '.agents', 'skills', 'delegator');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'SKILL.md');
  // remove the frontmatter stamp, but plant the SHIPPED stamp as a column-0 body line — must still be 'unknown'
  const tampered = shipped.replace(/\n\s*delegator-skill-version:[^\n]*/, '') + `\n\ndelegator-skill-version: "${shippedVer}"\n`;
  fs.writeFileSync(dest, tampered, 'utf8');
  const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'doctor'], { cwd: home, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(dest, 'utf8'), shipped, 'a body-only stamp must not count as current; the skill must be refreshed');
});

// under CI, auto-refresh must be SKIPPED — a stale installed skill is left untouched.
test('startup does NOT refresh skills under CI', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-ci-home-'));
  const env = { ...process.env, CI: '1', HOME: home, USERPROFILE: home, DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-ci-dlg-')) };
  const generic = path.join(root, 'adapters', 'generic', 'skills', 'delegator', 'SKILL.md');
  const dir = path.join(home, '.agents', 'skills', 'delegator');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'SKILL.md');
  const stale = fs.readFileSync(generic, 'utf8').replace(/delegator-skill-version:\s*["'][^"'\n]+["']/, 'delegator-skill-version: "2000-01-01T00:00:00Z"');
  fs.writeFileSync(dest, stale, 'utf8');
  const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'doctor'], { cwd: home, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(dest, 'utf8'), /delegator-skill-version: "2000-01-01T00:00:00Z"/, 'under CI the stale skill must be left untouched');
});

test('key list --json emits JSON (the parent command no longer shadows the flag)', () => {
  const r = runCli(['key', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `key list --json must emit JSON, got:\n${r.stdout}`);
});

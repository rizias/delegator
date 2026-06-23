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

test('skill help distinguishes host instruction packs from worker runtime equipment', () => {
  const r = runCli(['skill', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /install HOST instruction packs/);
  assert.match(r.stdout, /NOT the per-worker equip\.skills CLI toggles/);
});

// The shipped codex pack must be a discoverable Codex skill: valid YAML frontmatter
// (name + description) or Codex never surfaces it. CRLF is normalized so the guard
// holds on Windows checkouts — a literal \n match would be brittle.
test('shipped codex adapter is a valid Codex skill (SKILL.md frontmatter)', () => {
  const text = fs.readFileSync(path.join(root, 'adapters', 'codex', 'skills', 'delegator', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /^---\n/);
  assert.match(text, /^name: delegator$/m);
  assert.match(text, /^description: .+/m);
  assert.match(text, /\n---\n/);
});

test('codex skill install targets skills/delegator/SKILL.md, leaves AGENTS.md', () => {
  const adapterDir = path.join(root, 'adapters', 'codex', 'skills', 'delegator');
  const adapterFile = path.join(adapterDir, 'SKILL.md');
  const hadDir = fs.existsSync(adapterDir);
  const hadFile = fs.existsSync(adapterFile);
  const previous = hadFile ? fs.readFileSync(adapterFile, 'utf8') : '';
  fs.mkdirSync(adapterDir, { recursive: true });
  fs.writeFileSync(adapterFile, '# codex pack\n', 'utf8');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-codex-project-'));
  try {
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'skill', 'install', 'codex', '--project'], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-codex-home-')) },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(project, '.codex', 'skills', 'delegator', 'SKILL.md'), 'utf8'), '# codex pack\n');
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
  } finally {
    if (hadFile) fs.writeFileSync(adapterFile, previous, 'utf8');
    else fs.rmSync(adapterFile, { force: true });
    if (!hadDir) fs.rmSync(adapterDir, { recursive: true, force: true });
  }
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

// The shipped generic skill must be a valid, host-NEUTRAL Agent Skill: Pi and any Agent-Skills
// reader surface it from name+description, so those carry the triggers, and the body must not leak
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

// Both the canonical host and the `agents-skills` alias must install the same SKILL.md into
// .agents/skills/delegator/ and never write an AGENTS.md (file-based like the codex test, because
// `skill install --json` is not wired to emit JSON for any host today).
test('agent-skills skill install writes .agents/skills/delegator/SKILL.md (project); agents-skills alias works', () => {
  for (const host of ['agent-skills', 'agents-skills']) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-agentskills-project-'));
    const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'skill', 'install', host, '--project'], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', DELEGATOR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-agentskills-home-')) },
    });
    assert.equal(r.status, 0, r.stderr);
    const dest = path.join(project, '.agents', 'skills', 'delegator', 'SKILL.md');
    const installed = fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n');
    assert.match(installed, /^---\n/);
    assert.match(installed, /^name: delegator$/m);
    // a SKILL.md install must never touch AGENTS.md
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
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

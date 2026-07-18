// The `dlg provider disable/enable` writer must edit ONLY the toggled `disabled: true` line and
// leave every other byte of the hand-maintained providers.yaml untouched (comments, flow style,
// spacing). These tests pin that byte-fidelity so a future change can't silently reintroduce the
// whole-document re-serialization that reflowed unrelated blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');

function writeHome(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-fmt-'));
  fs.writeFileSync(path.join(home, 'providers.yaml'), yaml, 'utf8');
  return home;
}

function cli(home, args) {
  return spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI: '1', DELEGATOR_HOME: home },
  });
}

// A fixture that exercises the formatting the yaml serializer used to mangle: a top comment, an
// inline comment on a provider key and on a model key, a flow-empty `{}` model, a flow array, and
// a long quoted string.
const FIXTURE = [
  '# registry comment',
  'version: 1',
  'providers:',
  '  # provider-level comment',
  '  zai:                     # inline comment on the provider key',
  '    kind: openai-compatible # kind comment',
  '    auth: none',
  '    models:',
  '      glm-5.2: {}          # a flow-empty model',
  '  openai-codex:',
  '    kind: codex-cli',
  '    defaultRuntime: codex',
  '    models:',
  '      spark:               # inline comment on a model key',
  '        card:',
  '          goodFor: ["mechanical edits", "scaffolding / boilerplate", "rename or format across files"]',
  '          notes: "Near-instant. Benchmark 2026-07: fastest (~89s avg) and cheapest (~$0.11/task)."',
  'workers: {}',
  'tiers: {}',
  '',
].join('\n');

test('provider disable then enable restores the file byte-for-byte', () => {
  const home = writeHome(FIXTURE);
  const file = path.join(home, 'providers.yaml');
  let r = cli(home, ['provider', 'disable', 'zai']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(home, ['provider', 'enable', 'zai']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE);
});

test('disable inserts exactly one line and changes nothing else', () => {
  const home = writeHome(FIXTURE);
  const file = path.join(home, 'providers.yaml');
  const r = cli(home, ['provider', 'disable', 'zai']);
  assert.equal(r.status, 0, r.stderr);
  const before = FIXTURE.split('\n');
  const now = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(now.length, before.length + 1);
  const idx = now.findIndex((l) => l.trim() === 'disabled: true');
  assert.notEqual(idx, -1);
  assert.equal(now[idx], '    disabled: true'); // first child indent of `  zai:`
  assert.deepEqual(now.slice(0, idx).concat(now.slice(idx + 1)), before); // every other line identical
});

test('a flow-empty {} model round-trips to exactly {} and leaves siblings byte-identical', () => {
  const home = writeHome(FIXTURE);
  const file = path.join(home, 'providers.yaml');
  let r = cli(home, ['provider', 'disable', 'zai', 'glm-5.2']);
  assert.equal(r.status, 0, r.stderr);
  const parked = fs.readFileSync(file, 'utf8');
  assert.match(parked, /glm-5\.2: \{ disabled: true \} {10}# a flow-empty model/); // inline comment kept
  assert.ok(parked.includes('          goodFor: ["mechanical edits", "scaffolding / boilerplate", "rename or format across files"]')); // untouched
  r = cli(home, ['provider', 'enable', 'zai', 'glm-5.2']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE);
});

test('toggling one provider never reformats another provider block', () => {
  const home = writeHome(FIXTURE);
  const file = path.join(home, 'providers.yaml');
  const codexBlock = FIXTURE.slice(FIXTURE.indexOf('  openai-codex:'));
  for (const args of [['provider', 'disable', 'zai'], ['provider', 'enable', 'zai']]) {
    const r = cli(home, args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(file, 'utf8').includes(codexBlock), `openai-codex block reflowed by: ${args.join(' ')}`);
  }
});

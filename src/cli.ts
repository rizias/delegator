#!/usr/bin/env node
// CLI surface. Every command supports --json via one global flag + a central renderer (emit).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import type { CouncilEnvelope, CouncilModelRef, Envelope, Policy, ReasoningEffort } from './types.js';
import { globalConfigPath, runsJournalPath, tailOf, updateCheckPath, dirSizeBytes } from './paths.js';
import { ConfigError, loadConfig, loadSecretPools, parseDuration, saveSecret } from './config.js';
import { listWorkers, resolveRunPlan, buildPlanView, type PlanView } from './registry.js';
import { buildComparison, type ComparisonView } from './compare.js';
import { fetchProviderModels } from './models.js';
import { initConfigHome, initProject } from './scaffold.js';
import { resolveBinary, killTree } from './proc.js';
import { scopeOccupancy } from './semaphore.js';
import { executeRun, applyRun, undoRun } from './runner.js';
import { runCouncil } from './council.js';
import { removeWorktree, pruneWorktreeAdmin } from './worktree.js';
import * as store from './runstore.js';

const program = new Command();
// Single source of version truth = package.json (read at runtime — works when installed
// globally too, since npm always ships package.json next to dist/).
const VERSION = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
program.name('dlg').description('delegator — brainless dispatch to cheap agentic workers (alias: delegator)').version(VERSION, '-v, --version');

function defineCommand(nameAndArgs: string): Command {
  return program.command(nameAndArgs).option('--json', 'output machine-readable JSON');
}

function emit(data: unknown, human: () => void, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

const UPDATE_PACKAGE = '@rizias/delegator';
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// update-check.json holds BOTH the npm-version check and the skill check. These helpers merge a single
// field instead of overwriting the file, so within one process the two checks don't clobber each other.
// The cache is deliberately best-effort: the npm check runs in a detached child, so two writers (or two
// concurrent `dlg` runs) can still race on the read-merge-write. Accepted — a dropped field just triggers
// a benign re-check next run; no skill is left stale and no file is corrupted. Not worth a cross-proc lock.
function readUpdateCheck(): { checkedAt?: number; latest?: string; skillCheckedAt?: number; skillCheckedVersion?: string } {
  try { return JSON.parse(fs.readFileSync(updateCheckPath(), 'utf8')); } catch { return {}; }
}
function writeUpdateCheck(patch: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(updateCheckPath()), { recursive: true });
    fs.writeFileSync(updateCheckPath(), JSON.stringify({ ...readUpdateCheck(), ...patch }), 'utf8');
  } catch { /* cache is best-effort */ }
}

function spawnUpdateCheck(cachePath: string): void {
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
try {
  const cachePath = process.argv[1];
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['view', '${UPDATE_PACKAGE}', 'version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  const latest = String(r.stdout || '').trim().split(/\\s+/).pop();
  if (r.status === 0 && /^\\d+\\.\\d+\\.\\d+/.test(latest || '')) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
    fs.writeFileSync(cachePath, JSON.stringify({ ...cur, checkedAt: Date.now(), latest }), 'utf8');
  }
} catch {}
`;
  const child = spawn(process.execPath, ['-e', script, cachePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function maybeCheckForUpdate(): void {
  try {
    if (process.env.CI || process.argv.includes('--json') || process.argv.includes('--version') || process.argv.includes('-v')) return;
    const cachePath = updateCheckPath();
    const cached = readUpdateCheck();
    const latest = typeof cached.latest === 'string' ? cached.latest : undefined;
    const checkedAt = typeof cached.checkedAt === 'number' ? cached.checkedAt : 0;
    const stale = Date.now() - checkedAt > UPDATE_CACHE_TTL_MS;
    if (stale) spawnUpdateCheck(cachePath);
    if (!stale && latest && compareSemver(latest, VERSION) > 0) {
      process.stderr.write(`\x1b[2mdelegator ${latest} available (you have ${VERSION}) — run: dlg update\x1b[0m\n`);
    }
  } catch { /* update checks must never affect startup */ }
}

// On startup, silently bring installed GLOBAL skills up to the version this dlg ships. No flag, no
// command — updating the dlg binary is what updates the skills. Cached (TTL + this dlg's version) in
// the same update-check.json so it isn't recomputed every command. Skipped under CI (never mutate a
// CI home) and for --version.
function maybeAutoUpdateSkills(): void {
  try {
    if (process.env.CI || process.argv.includes('--version') || process.argv.includes('-v')) return;
    const cached = readUpdateCheck();
    const fresh = cached.skillCheckedVersion === VERSION
      && typeof cached.skillCheckedAt === 'number'
      && Date.now() - cached.skillCheckedAt <= UPDATE_CACHE_TTL_MS;
    if (fresh) return;
    let refreshed = 0;
    let failed = false;
    for (const s of scanInstalledSkills()) {
      if (!s.stale) continue;
      // Isolate a per-host copy failure (e.g. an unreadable/locked dest) so one bad path can't stop the
      // others; if anything failed, don't mark the check fresh, so the next run retries it.
      try { fs.copyFileSync(adapterPath(...s.template), s.path); refreshed++; }
      catch { failed = true; }
    }
    if (!failed) writeUpdateCheck({ skillCheckedAt: Date.now(), skillCheckedVersion: VERSION });
    if (refreshed && !process.argv.includes('--json')) {
      process.stderr.write(`\x1b[2mdelegator: refreshed ${refreshed} installed skill(s) to the current version\x1b[0m\n`);
    }
  } catch { /* skill auto-update must never affect startup */ }
}

function fail(e: unknown): never {
  if (e instanceof ConfigError) {
    console.error(`config error: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    process.exit(2);
  }
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}

function formatTokens(total: number | undefined, reasoning: number | undefined): string {
  if (total === undefined) return '–';
  return reasoning !== undefined ? `${total} (incl. ${reasoning} reasoning)` : String(total);
}

function parseToolsList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseCouncilWorkers(value: string | undefined): CouncilModelRef[] {
  if (value === undefined) throw new ConfigError('council needs at least 2 different models — pass -w <h1,h2,...>');
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((handle) => ({ handle }));
}

function parseNonNegativeInt(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be a non-negative integer`);
  return Number(value);
}

function printEnvelope(env: Envelope): void {
  const t = env.usage.tokens?.total ? `, tokens ${formatTokens(env.usage.tokens.total, env.usage.tokens.reasoning)}` : '';
  const it = env.usage.iterations ? `, iterations ${env.usage.iterations}` : '';
  console.log(`run ${env.runId} — ${env.status} (worker ${env.workerId}, ${Math.round(env.usage.wallClockMs / 1000)}s${t}${it})`);
  if (env.changes.diffStat) console.log(`diff: ${env.changes.diffStat}`);
  if (env.changes.filesTouched.length) console.log(`files: ${env.changes.filesTouched.join(', ')}`);
  const v = env.verification;
  console.log(`verification: build ${v.build.status} · test ${v.test.status} · lint ${v.lint.status}`);
  if (env.changes.patchFile) console.log(`patch: ${env.changes.patchFile} (${env.changes.applied ? 'applied' : 'NOT applied'})`);
  if (env.worktree) console.log(`worktree kept: ${env.worktree}`);
  for (const err of env.errors) console.log(`error[${err.type}]: ${err.message}`);
  console.log(`stop reason: ${env.stopReason}`);
  console.log('summary:');
  console.log(env.summary.split('\n').map((l) => '  ' + l).join('\n'));
  if (env.changes.patchFile && !env.changes.applied) console.log(`next: dlg apply ${env.runId}`);
}

function tokenLine(tokens: CouncilEnvelope['candidates'][number]['tokens']): string {
  return `tok ${tokens?.input ?? 0}/${tokens?.output ?? 0}/${tokens?.reasoning ?? 0}/${tokens?.total ?? 0}`;
}

function printCouncilEnvelope(env: CouncilEnvelope): void {
  console.log(`council ${env.councilId} — ${env.stopReason} (${env.candidates.length} workers, quorum ${env.quorumMet ? 'met' : 'not met'})`);
  for (const c of env.candidates) {
    console.log(`${c.workerId}  ${c.status}  ${c.durationMs}ms  ${tokenLine(c.tokens)}`);
  }
  console.log(`totals: calls ${env.usage.calls}, tok ${env.usage.inputTokens}/${env.usage.outputTokens}/${env.usage.reasoningTokens}/${env.usage.totalTokens}, ${env.usage.wallClockMs}ms`);
  for (const w of env.warnings) console.log(`warning: ${w}`);
  console.log(env.bundle);
}

defineCommand('init')
  .description('one-time setup: create ~/.delegator (registry + secrets templates)')
  .action((opts: { json?: boolean }) => {
    const r = initConfigHome();
    initProject(process.cwd()); // silent best-effort; runs also do this on demand
    emit({
      created: r.created,
      configPath: r.path,
      runtimesCreated: r.runtimesCreated,
      runtimesPath: r.runtimesPath,
      secretsCreated: r.secretsCreated,
      secretsPath: r.secretsPath,
    }, () => {
      console.log(`config:  ${r.path} ${r.created ? '(created)' : '(already existed — left untouched)'}`);
      console.log(`runtimes: ${r.runtimesPath} ${r.runtimesCreated ? '(created)' : '(already existed — left untouched)'}`);
      console.log(`secrets: ${r.secretsPath} ${r.secretsCreated ? '(created with commented examples)' : '(already existed — see secrets.example.yaml next to it for the format)'}`);
      console.log('');
      console.log('next steps:');
      console.log('  1. dlg doctor                        # discovery data for agent-driven provider provisioning');
      console.log('  2. dlg providers                     # see which workers became available');
      console.log('  3. dlg skill install agent-skills    # universal skill (any Agent Skills-compatible agent)');
      console.log('     dlg skill install claude-code     # or: codex — for those specific orchestrators');
    }, opts.json);
  });

defineCommand('update')
  .description('self-update: npm i -g @rizias/delegator@latest')
  .action((opts: { json?: boolean }) => {
    const r = spawnSync(npmCommand(), ['i', '-g', `${UPDATE_PACKAGE}@latest`], {
      stdio: ['inherit', opts.json ? 'ignore' : 'inherit', 'pipe'],
      encoding: 'utf8',
      windowsHide: false,
      shell: process.platform === 'win32',
    });
    if (r.status === 0) {
      emit({ updated: true, package: UPDATE_PACKAGE }, () => {
        console.log('updated; restart dlg');
      }, opts.json);
      return;
    }
    const stderr = String(r.stderr ?? '').trim();
    if (stderr) console.error(tailOf(stderr, 4000));
    else if (r.error) console.error(r.error.message);
    process.exit(r.status ?? 1);
  });

defineCommand('providers')
  .description('discovery: list workers and availability')
  .option('--cwd <dir>', 'project root (applies that project\'s .delegator.yaml)', process.cwd())
  .action((opts: { json?: boolean; cwd: string }) => {
    try {
      store.setRunsProject(opts.cwd);
      const cfg = loadConfig(opts.cwd);
      for (const w of cfg.warnings ?? []) console.error(`warning: ${w}`);
      const infos = listWorkers(cfg);
      emit(infos, () => {
        if (infos.length === 0) {
          console.log('no workers — providers.yaml is empty. Run `dlg doctor` to see what this machine has, then add providers (or let your agent provision them).');
          return;
        }
        for (const w of infos) {
          const reason = w.reason ? `  (${w.reason})` : '';
          const ctx = w.contextWindow ? `${Math.round(w.contextWindow / 1000)}k` : '';
          console.log(`${w.id.padEnd(13)} ${w.status.padEnd(13)} ${w.runtime.padEnd(16)} ${(w.model ?? '').padEnd(20)} ${ctx.padEnd(6)}${reason}`);
        }
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('models [provider]')
  .description('list the models a provider offers RIGHT NOW — fetched live (opencode CLI / provider /models API), never hardcoded')
  .option('--filter <substr>', 'only show models whose id contains this substring')
  .option('--cwd <dir>', 'project root', process.cwd())
  .action(async (provider: string | undefined, opts: { filter?: string; cwd: string; json?: boolean }) => {
    try {
      const cfg = loadConfig(opts.cwd);
      const ids = provider ? [provider] : Object.keys(cfg.providers);
      const results: Array<{ provider: string; kind: string; note?: string; models: string[] }> = [];
      for (const pid of ids) {
        const r = await fetchProviderModels(pid, cfg);
        const list = opts.filter ? r.models.filter((m) => m.includes(opts.filter!)) : r.models;
        results.push({ provider: r.provider, kind: r.kind, ...(r.note ? { note: r.note } : {}), models: list });
      }
      emit(results, () => {
        for (const r of results) {
          console.log(`\n# ${r.provider} (${r.kind})${r.note ? ` — ${r.note}` : ''}`);
          for (const m of r.models) console.log(`  ${m}`);
          if (!r.models.length && !r.note) console.log('  (no models returned)');
        }
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('doctor')
  .description('diagnose environment')
  .action((opts: { json?: boolean }) => {
    const node = process.versions.node;
    const binaries = ['git', 'claude', 'codex', 'opencode', 'pi'].map((bin) => ({ bin, path: resolveBinary(bin) }));
    const env = ['OPENAI_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY'].map((name) => ({ name, set: Boolean(process.env[name]) }));
    const config = fs.existsSync(globalConfigPath()) ? globalConfigPath() : undefined;
    // A resolved binary is NOT the same as a usable worker: each CLI owns its own login, and
    // delegator only spawns it. A found-but-not-logged-in CLI fails at request time with 401 /
    // "not logged in" (which can even surface as a timeout while the CLI retries). Say so here.
    const loginReminder = binaries.some((b) => b.bin !== 'git' && b.path)
      ? 'A found worker CLI still needs its OWN login — delegator runs it, it does not log in for you. '
        + 'If a run fails with 401 / "not logged in" (or times out retrying), authenticate that CLI in '
        + 'your terminal first: run `claude` then /login, `codex login`, `opencode auth login`, etc.'
      : undefined;
    let doctorLoad: { warnings: string[]; infos: ReturnType<typeof listWorkers>; available: number } | undefined;
    let configError: string | undefined;
    try {
      const cfg = loadConfig(process.cwd());
      const infos = listWorkers(cfg);
      const avail = infos.filter((w) => w.status === 'available').length;
      doctorLoad = { warnings: cfg.warnings ?? [], infos, available: avail };
    } catch (e) {
      configError = String(e instanceof Error ? e.message : e);
    }
    emit({
      node: { version: node, ok: Number(node.split('.')[0]) >= 20 },
      binaries,
      env,
      config: config ?? null,
      ...(loginReminder ? { loginReminder } : {}),
      ...(doctorLoad ? {
        warnings: doctorLoad.warnings,
        workers: {
          available: doctorLoad.available,
          total: doctorLoad.infos.length,
          unavailable: doctorLoad.infos.filter((i) => i.status !== 'available'),
        },
      } : {}),
      ...(configError ? { configError } : {}),
    }, () => {
      console.log(`node: ${node} ${Number(node.split('.')[0]) >= 20 ? 'ok' : 'TOO OLD (need >=20)'}`);
      for (const bin of ['git', 'claude', 'codex', 'opencode', 'pi']) {
        const p = binaries.find((b) => b.bin === bin)!.path;
        console.log(`${bin}: ${p ?? 'NOT FOUND'}`);
      }
      for (const name of ['OPENAI_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY']) {
        console.log(`${name}: ${process.env[name] ? 'set' : 'not set'}`);
      }
      console.log(`config: ${fs.existsSync(globalConfigPath()) ? globalConfigPath() : 'missing — run: dlg init'}`);
      if (loginReminder) console.log(`\nlogin: ${loginReminder}`);
      if (doctorLoad) {
        for (const w of doctorLoad.warnings) console.log(`warning: ${w}`);
        console.log(`workers: ${doctorLoad.available}/${doctorLoad.infos.length} available`);
        for (const w of doctorLoad.infos.filter((i) => i.status !== 'available')) console.log(`  ${w.id}: ${w.status} — ${w.reason ?? ''}`);
      } else {
        console.log(`config not loadable: ${configError}`);
      }
    }, opts.json);
  });

// A plain program.command (not defineCommand): the `key` group has no action of its own, and adding
// `--json` here would shadow the same flag on its set/add/list subcommands (a duplicate parent option
// swallows the child's value), so per-subcommand `--json` would silently stop working.
const keyCmd = program.command('key')
  .description('manage provider API keys (secrets.yaml — never readable by agents)');

function registryProviderIds(): string[] | null {
  try {
    return Object.keys(loadConfig(process.cwd()).providers);
  } catch {
    return null;
  }
}

function warnUnknownProvider(provider: string): void {
  const ids = registryProviderIds();
  if (ids && !ids.includes(provider)) {
    console.error(`warning: "${provider}" is not a provider id in providers.yaml (known: ${ids.join(', ')})`);
    console.error('the key is stored but will not be used until a provider with that id exists');
  }
}

function readKeyFromStdin(provider: string, verb: string): string {
  if (process.stdin.isTTY) {
    console.error(`no key on stdin. usage: echo <KEY> | dlg key ${verb} ${provider}`);
    console.error('(stdin keeps the key out of shell history and agent transcripts)');
    process.exit(2);
  }
  const data = fs.readFileSync(0, 'utf8').trim();
  if (!data) {
    console.error(`empty stdin. usage: echo <KEY> | dlg key ${verb} ${provider}`);
    process.exit(2);
  }
  return data;
}

keyCmd
  .command('set <provider>')
  .description('replace the provider key pool with one key from stdin: echo <KEY> | dlg key set zai')
  .option('--json', 'output machine-readable JSON')
  .action((provider: string, opts: { json?: boolean }) => {
    try {
      saveSecret(provider, readKeyFromStdin(provider, 'set'));
      emit({ provider, saved: true, mode: 'set' }, () => {
        console.log(`key for "${provider}" saved to secrets.yaml (pool replaced). Never commit or share that file.`);
      }, opts.json);
      warnUnknownProvider(provider);
    } catch (e) { fail(e); }
  });

keyCmd
  .command('add <provider>')
  .description('append a key to the provider pool (runs rotate through the pool round-robin)')
  .option('--json', 'output machine-readable JSON')
  .action((provider: string, opts: { json?: boolean }) => {
    try {
      saveSecret(provider, readKeyFromStdin(provider, 'add'), { append: true });
      const n = loadSecretPools()[provider]?.length ?? 1;
      emit({ provider, saved: true, mode: 'add', keyCount: n }, () => {
        console.log(`key appended: "${provider}" pool now holds ${n} key(s); runs rotate round-robin.`);
      }, opts.json);
      warnUnknownProvider(provider);
    } catch (e) { fail(e); }
  });

keyCmd
  .command('list')
  .description('show which providers have stored keys (values are never printed)')
  .option('--json', 'output machine-readable JSON')
  .action((opts: { json?: boolean }) => {
    const pools = loadSecretPools();
    const ids = Object.keys(pools).sort();
    const registry = registryProviderIds();
    const entries = ids.map((id) => {
      const pool = pools[id]!;
      return {
        provider: id,
        keyCount: pool.length,
        first: `****${pool[0]!.slice(-4)}`,
        orphan: Boolean(registry && !registry.includes(id)),
      };
    });
    emit(entries, () => {
      if (!ids.length) {
        console.log('no keys stored. add one: echo <KEY> | dlg key set <provider>');
        return;
      }
      for (const entry of entries) {
        const orphan = entry.orphan ? '  [no such provider in registry!]' : '';
        console.log(`${entry.provider.padEnd(14)} ${entry.keyCount} key(s) (first: ${entry.first})${orphan}`);
      }
    }, opts.json);
  });

defineCommand('restrict')
  .description('limit which workers/tiers this project may use (writes .delegator.yaml)')
  .option('-w, --workers <ids>', 'comma-separated worker ids to allow')
  .option('-t, --tiers <names>', 'comma-separated tier names to allow')
  .option('--clear', 'remove the restriction')
  .action((opts: { workers?: string; tiers?: string; clear?: boolean; json?: boolean }) => {
    try {
      const projPath = path.join(process.cwd(), '.delegator.yaml');
      const block: { workers?: string[]; tiers?: string[] } = {};
      if (opts.workers) block.workers = opts.workers.split(',').map((s) => s.trim()).filter(Boolean);
      if (opts.tiers) block.tiers = opts.tiers.split(',').map((s) => s.trim()).filter(Boolean);
      if (fs.existsSync(projPath)) {
        // Don't clobber an existing project file — show the block to paste.
        const yaml = opts.clear ? 'restrict: {}   # (or delete this key)' : stringifyYaml({ restrict: block }).trim();
        emit({ written: false, projectConfigPath: projPath, yaml }, () => {
          console.log(`.delegator.yaml already exists. Set this key by hand:\n\n${yaml}`);
        }, opts.json);
        return;
      }
      const header = '# delegator project config — overrides ~/.delegator/providers.yaml for THIS repo.\n# Never put API keys here (secrets live in ~/.delegator/secrets.yaml).\n\n';
      fs.writeFileSync(projPath, header + (opts.clear ? '' : stringifyYaml({ restrict: block })), 'utf8');
      const cfg = loadConfig(process.cwd());
      const avail = listWorkers(cfg).filter((w) => w.status === 'available').map((w) => w.id);
      emit({ written: true, projectConfigPath: projPath, workers: avail }, () => {
        console.log(`wrote ${projPath}`);
        console.log(`workers now usable here: ${avail.join(', ') || '(none — check ids)'}`);
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('run')
  .description('delegate one task to a worker or tier. Exit codes: 0 completed, 4 non-success run (partial/requires-review/failed/killed, envelope still valid), 3 rejected, 2 usage/config, 1 CLI error')
  .option('-w, --worker <id>', 'worker id')
  .option('-t, --tier <name>', 'tier name')
  .option('-f, --brief-file <path>', 'brief file (markdown)')
  .option('-m, --message <text>', 'inline task/brief text')
  .option('--task <text>', 'the task to do — clearer alias of -m')
  .option('--policy <policy>', 'auto | review | plan-first')
  .option('--budget <duration>', 'wall-clock budget, e.g. 10m')
  .option('--effort <level>', 'model-specific reasoning effort level (overrides the worker default)')
  .option('--tools <names>', 'comma-separated allowed tools for compatible runtimes')
  .option('--cwd <dir>', 'project root', process.cwd())
  .action(async (opts: {
    worker?: string; tier?: string; briefFile?: string; message?: string; task?: string;
    policy?: string; budget?: string; effort?: string; tools?: string; cwd: string; json?: boolean;
  }) => {
    try {
      store.setRunsProject(opts.cwd);
      const cfg = loadConfig(opts.cwd);
      let brief = opts.task ?? opts.message ?? '';
      if (opts.briefFile) brief = fs.readFileSync(opts.briefFile, 'utf8');
      if (!brief.trim()) throw new ConfigError('no task: pass -f <file> or --task "<text>"');
      const policy = (opts.policy ?? cfg.defaults.policy) as Policy;
      if (!['auto', 'review', 'plan-first'].includes(policy)) throw new ConfigError(`bad policy: ${policy}`);
      const budgetOverride: { wallClockMs?: number } = {};
      if (opts.budget) budgetOverride.wallClockMs = parseDuration(opts.budget);
      const env = await executeRun({
        workerId: opts.worker, tier: opts.tier, brief, cwd: opts.cwd, policy, budgetOverride,
        ...(opts.effort ? { effortOverride: opts.effort as ReasoningEffort } : {}),
        ...(opts.tools !== undefined ? { toolsOverride: parseToolsList(opts.tools) ?? [] } : {}),
      }, cfg);
      emit(env, () => printEnvelope(env), opts.json);
      // Exit codes (documented in --help and USAGE.md):
      //   0 completed · 2 usage/config error · 3 rejected (never started)
      //   4 finished with a non-success status (partial / requires-review / failed / killed-*) — envelope is valid
      //   1 internal CLI error
      const code = env.status === 'completed' ? 0 : env.status === 'rejected' ? 3 : 4;
      process.exit(code);
    } catch (e) { fail(e); }
  });

defineCommand('council')
  .description('run the same task across several workers and print candidate bundle')
  .option('-w, --worker <ids>', 'comma-separated worker ids')
  .option('-f, --brief-file <path>', 'brief file (markdown)')
  .option('-m, --message <text>', 'inline task/brief text')
  .option('--cwd <dir>', 'project root', process.cwd())
  .option('--budget <duration>', 'wall-clock budget per worker, e.g. 10m')
  .option('--min-proposers <n>', 'minimum usable answers for quorum', '2')
  .option('--max-retries <n>', 'retries per worker', '0')
  .option('--aggregate <model>', 'run one final model over the bundle')
  .action(async (opts: {
    worker?: string; briefFile?: string; message?: string; cwd: string; budget?: string;
    minProposers: string; maxRetries: string; aggregate?: string; json?: boolean;
  }) => {
    try {
      store.setRunsProject(opts.cwd);
      const cfg = loadConfig(opts.cwd);
      let brief = opts.message ?? '';
      if (opts.briefFile) brief = fs.readFileSync(opts.briefFile, 'utf8');
      if (!brief.trim()) throw new ConfigError('no task: pass -f <file> or -m "<text>"');
      const env = await runCouncil({
        task: brief,
        cwd: opts.cwd,
        options: {
          models: parseCouncilWorkers(opts.worker),
          ...(opts.budget ? { budget: opts.budget } : {}),
          minProposers: parseNonNegativeInt(opts.minProposers, '--min-proposers'),
          maxRetriesPerWorker: parseNonNegativeInt(opts.maxRetries, '--max-retries'),
        },
        ...(opts.aggregate ? { aggregateWith: opts.aggregate } : {}),
      }, cfg);
      emit(env, () => printCouncilEnvelope(env), opts.json);
      process.exit(0);
    } catch (e) { fail(e); }
  });

function printPlan(v: PlanView): void {
  console.log(`plan: ${v.selector} · fallback: ${v.fallback}`);
  if (v.briefChars !== undefined) console.log(`brief: ${v.briefChars} chars (~${v.briefEstTokens} tokens est.)`);
  console.log('');
  for (const c of v.candidates) {
    const ctx = c.contextWindow !== undefined ? `${Math.round(c.contextWindow / 1000)}k` : '—';
    const pool = c.pool ?? '—';
    const fit = c.fitsContext === undefined ? '' : c.fitsContext ? ' · fits' : ' · BRIEF OVERFLOWS WINDOW';
    const status = c.available ? `available${fit}` : (c.skipReason ?? 'unavailable');
    const price = c.price?.inPerMtok !== undefined ? `  $${c.price.inPerMtok}/$${c.price.outPerMtok ?? '?'} per Mtok` : '';
    console.log(`  ${c.n}. ${c.workerId.padEnd(13)} ${(c.model ?? '—').padEnd(20)} ${(c.runtime ?? '—').padEnd(16)} ${pool.padEnd(26)} ctx ${ctx.padEnd(5)} ${status}${price}`);
  }
  console.log('');
  if (v.wouldRunWorkerId) {
    console.log(v.fallback === 'auto' && v.candidates.length > 1
      ? `would run: ${v.wouldRunWorkerId} first; falls over to the rest on a provider failure (auto).`
      : `would run: ${v.wouldRunWorkerId}.`);
  } else {
    console.log('would run: NOTHING — no candidate is available right now (see the skip reasons above).');
  }
}

function printRoute(plan: ReturnType<typeof resolveRunPlan>): void {
  for (let i = 0; i < plan.candidates.length; i++) {
    const c = plan.candidates[i]!;
    const runtime = c.worker?.runtime ?? '—';
    const target = c.worker ? `${c.worker.provider}/${c.worker.model ?? '—'}` : '—';
    const status = c.available ? 'available' : (c.skipReason ?? 'unavailable');
    console.log(`${String(i + 1).padStart(2)}  ${c.workerId.padEnd(24)} ${runtime.padEnd(12)} ${target.padEnd(32)} ${status}`);
  }
}

defineCommand('plan')
  .description('dry run: show the resolved worker/chain, availability, provider pool and context-fit — WITHOUT spawning anything or spending tokens')
  .option('-w, --worker <id>', 'worker id')
  .option('-t, --tier <name>', 'tier name')
  .option('-f, --brief-file <path>', 'brief file (markdown) — only for the context-fit estimate')
  .option('-m, --message <text>', 'inline task text — only for the context-fit estimate')
  .option('--task <text>', 'the task text — clearer alias of -m')
  .option('--cwd <dir>', 'project root', process.cwd())
  .action((opts: { worker?: string; tier?: string; briefFile?: string; message?: string; task?: string; cwd: string; json?: boolean }) => {
    try {
      store.setRunsProject(opts.cwd);
      const cfg = loadConfig(opts.cwd);
      let brief: string | undefined = opts.task ?? opts.message;
      if (opts.briefFile) brief = fs.readFileSync(opts.briefFile, 'utf8');
      const plan = resolveRunPlan(cfg, { workerId: opts.worker, tier: opts.tier });
      const view = buildPlanView(plan, brief);
      emit(view, () => printPlan(view), opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('route')
  .description('show the resolved fallback chain for a worker handle (defaults to defaults.model)')
  .option('-w, --worker <handle>', 'worker handle (omit to use defaults.model)')
  .option('--cwd <dir>', 'project root', process.cwd())
  .action((opts: { worker?: string; cwd: string; json?: boolean }) => {
    try {
      store.setRunsProject(opts.cwd);
      const cfg = loadConfig(opts.cwd);
      // tolerant: inspection never aborts — an unconfigured/missing-key head is shown, not thrown.
      const plan = resolveRunPlan(cfg, { workerId: opts.worker }, { tolerant: true });
      emit(plan, () => printRoute(plan), opts.json);
    } catch (e) { fail(e); }
  });

function printComparison(v: ComparisonView): void {
  const m = (s: string): string => (s === 'passed' ? 'ok' : s === 'failed' ? 'FAIL' : '–');
  const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  console.log(`comparing ${v.rows.length} run(s):\n`);
  for (const r of v.rows) {
    const wall = r.wallClockMs !== undefined ? `${Math.round(r.wallClockMs / 1000)}s` : '–';
    const tokens = r.tokensTotal !== undefined
      ? (r.tokensReasoning !== undefined ? `${tok(r.tokensTotal)} (incl. ${tok(r.tokensReasoning)} reasoning)` : tok(r.tokensTotal))
      : '–';
    const patch = r.patchSha256 ? r.patchSha256.slice(0, 7) : '–';
    console.log(
      `  ${r.runId.padEnd(13)} ${r.workerId.padEnd(12)} ${r.status.padEnd(16)} ` +
      `v:${m(r.build)}/${m(r.test)}/${m(r.lint)}  files ${String(r.filesTouched).padEnd(3)} ` +
      `tok ${tokens.padEnd(6)} ${wall.padEnd(5)} patch ${patch}${r.applied ? ' APPLIED' : ''}`,
    );
  }
  console.log('');
  console.log(`  completed (apply-ready): ${v.completedRunIds.join(', ') || '—'}`);
  if (v.identicalPatchGroups.length) {
    for (const g of v.identicalPatchGroups) console.log(`  identical patch (byte-for-byte): ${g.join(' = ')}`);
  } else {
    console.log('  identical patch: none — every run produced a different patch');
  }
  if (v.fastestRunId) console.log(`  fastest: ${v.fastestRunId}`);
  if (v.fewestTokensRunId) console.log(`  fewest tokens: ${v.fewestTokensRunId}`);
}

defineCommand('compare-runs <ids...>')
  .description('compare finished runs side by side (status, verification, diff, cost, identical-patch convergence) — read-only, no spawn')
  .action((ids: string[], opts: { json?: boolean }) => {
    try {
      const envs = ids.map((id) => {
        const env = store.readEnvelope(id);
        if (!env) throw new ConfigError(`run ${id} has no envelope yet (not finished, or unknown id)`);
        return env;
      });
      const view = buildComparison(envs);
      emit(view, () => printComparison(view), opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('status [id]')
  .description('list runs / show one run meta')
  .option('--cwd <dir>', 'project the run belongs to (for runs started with run --cwd)', process.cwd())
  .action((id: string | undefined, opts: { json?: boolean; cwd: string }) => {
    try {
      store.setRunsProject(opts.cwd);
      if (id) {
        const meta = store.readMeta(id);
        emit(meta, () => {
          const end = meta.endedAt ? new Date(meta.endedAt).getTime() : Date.now();
          const elapsed = Math.round((end - new Date(meta.createdAt).getTime()) / 1000);
          console.log(`${meta.id}  ${meta.state}  worker=${meta.workerId}  elapsed=${elapsed}s`);
          const tail = store.readEventsTail(id, 3);
          let lastTs: number | null = null;
          for (const l of tail) {
            try { lastTs = (JSON.parse(l) as { ts: number }).ts; } catch { /* skip */ }
          }
          if (lastTs !== null && !meta.endedAt) {
            console.log(`last activity: ${Math.round((Date.now() - lastTs) / 1000)}s ago`);
          }
          for (const l of tail) {
            try {
              const ev = JSON.parse(l) as { stream: string; raw: string };
              console.log(`  [${ev.stream}] ${ev.raw.slice(0, 120)}`);
            } catch { /* skip */ }
          }
        }, opts.json);
        return;
      }
      const metas = store.listRuns();
      emit(metas, () => {
        for (const m of metas.slice(0, 30)) {
          console.log(`${m.id}  ${m.state.padEnd(10)} ${m.workerId.padEnd(14)} ${m.createdAt}`);
        }
        if (!metas.length) console.log('no runs yet');
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('result <id>')
  .description('print the result envelope')
  .option('--cwd <dir>', 'project the run belongs to (for runs started with run --cwd)', process.cwd())
  .action((id: string, opts: { json?: boolean; cwd: string }) => {
    try {
      store.setRunsProject(opts.cwd);
      const env = store.readEnvelope(id);
      if (!env) { console.error(`run ${id}: no envelope yet`); process.exit(1); }
      emit(env, () => printEnvelope(env), opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('logs <id>')
  .description('tail worker events')
  .option('--tail <n>', 'lines', '40')
  .option('--cwd <dir>', 'project the run belongs to (for runs started with run --cwd)', process.cwd())
  .action((id: string, opts: { tail: string; cwd: string; json?: boolean }) => {
    try {
      store.setRunsProject(opts.cwd);
      const lines = store.readEventsTail(id, Number(opts.tail));
      emit({ runId: id, tail: Number(opts.tail), lines }, () => {
        for (const line of lines) console.log(line);
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('apply <id>')
  .description('apply a reviewed patch to the main tree')
  .option('--cwd <dir>', 'project the run belongs to (needed for runs started with run --cwd)', process.cwd())
  .action((id: string, opts: { cwd: string; json?: boolean }) => {
    try {
      store.setRunsProject(opts.cwd);
      const env = applyRun(id);
      emit({ runId: id, applied: true, diffStat: env.changes.diffStat, filesTouched: env.changes.filesTouched }, () => {
        console.log(`applied ${id}: ${env.changes.diffStat || env.changes.filesTouched.join(', ')}`);
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('undo <id>')
  .description('roll back an applied run — reverse its patch out of the main tree')
  .option('--cwd <dir>', 'project the run belongs to (needed for runs started with run --cwd)', process.cwd())
  .action((id: string, opts: { cwd: string; json?: boolean }) => {
    try {
      store.setRunsProject(opts.cwd);
      const env = undoRun(id);
      emit({ runId: id, undone: true, diffStat: env.changes.diffStat, filesTouched: env.changes.filesTouched }, () => {
        console.log(`undid ${id}: reversed ${env.changes.diffStat || env.changes.filesTouched.join(', ')}`);
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('kill <id>')
  .description('kill a running worker (process tree)')
  .option('--cwd <dir>', 'project the run belongs to (for runs started with run --cwd)', process.cwd())
  .action(async (id: string, opts: { cwd: string; json?: boolean }) => {
    try {
      store.setRunsProject(opts.cwd);
      const meta = store.readMeta(id);
      if (!meta.pid) { console.error(`run ${id}: no pid recorded`); process.exit(1); }
      await killTree(meta.pid);
      emit({ runId: id, pid: meta.pid, signalSent: true }, () => {
        console.log(`kill signal sent to ${id} (pid ${meta.pid})`);
      }, opts.json);
    } catch (e) { fail(e); }
  });

// Adapters ship INSIDE the package (adapters/ next to dist/) — the single source
// of truth is the repo; installation copies from here into the host's location.
function adapterPath(...segments: string[]): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/dist
  return path.join(here, '..', 'adapters', ...segments);
}

// NOTE: a plain program.command (not defineCommand) — the `skill` group has no action of its own, and
// adding `--json` here would shadow the same flag on its show/install subcommands (a duplicate parent
// option swallows the child's value), so per-subcommand `--json` would silently stop working.
const skillCmd = program.command('skill')
  .description('install a host skill (teach an orchestrator when/how to delegate) — NOT the per-worker equip.skills CLI toggles');

// Bundled host skills. ONE table drives install, the supported-host list, and the startup auto-refresh
// so the paths can never drift. Each host's SKILL.md frontmatter carries metadata.delegator-skill-version
// (a UTC timestamp), so the startup check can tell an installed copy from the version this dlg ships.
type SkillHost = { host: string; aliases?: string[]; template: string[]; dir: string[]; installedMsg: string };
const SKILL_HOSTS: SkillHost[] = [
  { host: 'claude-code', template: ['claude-code', 'skills', 'delegator', 'SKILL.md'], dir: ['.claude', 'skills', 'delegator'],
    installedMsg: 'new Claude Code sessions now know when and how to use delegator (/delegator).' },
  { host: 'codex', template: ['codex', 'skills', 'delegator', 'SKILL.md'], dir: ['.codex', 'skills', 'delegator'],
    installedMsg: 'new Codex sessions now know when and how to use delegator (/delegator).' },
  { host: 'agent-skills', aliases: ['agents-skills'], template: ['generic', 'skills', 'delegator', 'SKILL.md'], dir: ['.agents', 'skills', 'delegator'],
    installedMsg: 'any Agent Skills-compatible agent now discovers the delegator skill.' },
];
const findSkillHost = (host: string): SkillHost | undefined =>
  SKILL_HOSTS.find((h) => h.host === host || (h.aliases?.includes(host) ?? false));
const skillDest = (h: SkillHost): string => path.join(os.homedir(), ...h.dir, 'SKILL.md');
// Read the version stamped in an installed skill's frontmatter (metadata.delegator-skill-version).
// Scope the search to the FIRST `---`-delimited frontmatter block so a stray line in the body can't be
// mistaken for the stamp; no frontmatter / no stamp → 'unknown' (treated as stale by scanInstalledSkills).
function skillVersion(text: string): string {
  const norm = text.replace(/\r\n/g, '\n');
  const fm = norm.match(/^---\n([\s\S]*?)\n---/);
  const m = (fm?.[1] ?? '').match(/^\s*delegator-skill-version:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m?.[1]?.trim() ?? 'unknown';
}
// Scan the GLOBAL install location of every host for an installed delegator skill and compare its
// version STAMP (not content) to the stamp this dlg ships. Drives the startup auto-refresh.
function scanInstalledSkills(): Array<{ host: string; path: string; installed: string; shipped: string; stale: boolean; template: string[] }> {
  const out: Array<{ host: string; path: string; installed: string; shipped: string; stale: boolean; template: string[] }> = [];
  for (const skillHost of SKILL_HOSTS) {
    const p = path.join(os.homedir(), ...skillHost.dir, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    // Per-host isolation: an unreadable installed file (or a missing shipped template) must not abort the
    // scan of the OTHER hosts. On a read failure treat the install as stale so the refresh tries to heal
    // it by overwriting with the shipped copy.
    try {
      const shipped = skillVersion(fs.readFileSync(adapterPath(...skillHost.template), 'utf8'));
      const installed = skillVersion(fs.readFileSync(p, 'utf8'));
      out.push({ host: skillHost.host, path: p, installed, shipped, stale: installed !== shipped, template: skillHost.template });
    } catch {
      out.push({ host: skillHost.host, path: p, installed: 'unreadable', shipped: '', stale: true, template: skillHost.template });
    }
  }
  return out;
}

skillCmd
  .command('show')
  .description('print the generic delegator SKILL.md (paste into any agent that has no installer)')
  .option('--json', 'output machine-readable JSON')
  .action((opts: { json?: boolean }) => {
    try {
      const text = fs.readFileSync(adapterPath('generic', 'skills', 'delegator', 'SKILL.md'), 'utf8');
      emit({ text }, () => {
        process.stdout.write(text);
      }, opts.json);
    } catch (e) { fail(e); }
  });

skillCmd
  .command('install <host>')
  .description('install a host skill globally — host: claude-code | codex | agent-skills')
  .option('--json', 'output machine-readable JSON')
  .action((host: string, opts: { json?: boolean }) => {
    try {
      const skillHost = findSkillHost(host);
      if (!skillHost) {
        console.error(`unknown host "${host}". Supported hosts: ${SKILL_HOSTS.map((h) => h.host).join(', ')}.`);
        console.error('For any other agent: dlg skill show   # then paste the skill into its instruction file');
        process.exit(2);
        return;
      }
      const dest = skillDest(skillHost);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(adapterPath(...skillHost.template), dest);
      emit({ host: skillHost.host, installed: true, path: dest }, () => {
        console.log(`installed skill: ${dest}`);
        console.log(skillHost.installedMsg);
        console.log('delegator keeps it up to date automatically when you update dlg.');
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('queue')
  .description('show concurrency scopes and how many slots are in use')
  .action((opts: { json?: boolean }) => {
    try {
      const cfg = loadConfig(process.cwd());
      const scopes = new Map<string, number>();
      for (const p of Object.values(cfg.providers)) {
        const scope = p.concurrencyGroup ?? '';
        const limit = p.maxConcurrent ?? 0;
        if (limit > 0) {
          const key = p.concurrencyGroup ?? '(per-provider)';
          scopes.set(key, Math.max(scopes.get(key) ?? 0, limit));
        }
      }
      const rows: Array<{ scope: string; held: number; limit: number; shared: boolean }> = [];
      // Per-provider scopes (no group): scope name == provider id.
      for (const [pid, p] of Object.entries(cfg.providers)) {
        const limit = p.maxConcurrent ?? 0;
        if (limit > 0 && !p.concurrencyGroup) {
          const occ = scopeOccupancy(pid);
          rows.push({ scope: pid, held: occ.held, limit, shared: false });
        }
      }
      // Grouped scopes.
      const groups = new Set(Object.values(cfg.providers).map((p) => p.concurrencyGroup).filter(Boolean) as string[]);
      for (const g of groups) {
        const limit = Math.min(...Object.values(cfg.providers).filter((p) => p.concurrencyGroup === g).map((p) => p.maxConcurrent ?? 0).filter((n) => n > 0));
        const occ = scopeOccupancy(g);
        rows.push({ scope: g, held: occ.held, limit, shared: true });
      }
      emit(rows, () => {
        for (const row of rows) {
          if (row.shared) console.log(`${row.scope.padEnd(16)} ${row.held}/${row.limit} in use  (shared group)`);
          else console.log(`${row.scope.padEnd(16)} ${row.held}/${row.limit} in use`);
        }
        if (![...Object.values(cfg.providers)].some((p) => (p.maxConcurrent ?? 0) > 0)) {
          console.log('no concurrency limits set (all providers unbounded)');
        }
      }, opts.json);
    } catch (e) { fail(e); }
  });

defineCommand('gain')
  .description('local savings summary from runs.jsonl')
  .option('--history', 'show recent runs one per line')
  .action((opts: { history?: boolean; json?: boolean }) => {
    const p = runsJournalPath();
    if (!fs.existsSync(p)) {
      emit({ rows: [], totalRuns: 0 }, () => {
        console.log('no runs recorded yet');
      }, opts.json);
      return;
    }
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    interface Row { ts: string; runId: string; project?: string; workerId: string; status: string; tokens: number | null; tokensReasoning?: number | null; wallClockMs: number }
    const rows: Row[] = [];
    for (const l of lines) {
      try { rows.push(JSON.parse(l) as Row); } catch { /* skip corrupt line */ }
    }
    if (opts.history) {
      const history = rows.slice(-20);
      emit(history, () => {
        for (const r of history) {
          const t = r.tokens !== null && r.tokens !== undefined ? formatTokens(r.tokens, r.tokensReasoning ?? undefined) : '-';
          console.log(`${r.ts}  ${r.runId}  ${(r.workerId ?? '').padEnd(14)} ${(r.status ?? '').padEnd(12)} ${t.padStart(8)} tok  ${String(Math.round((r.wallClockMs ?? 0) / 1000)).padStart(5)}s  ${r.project ?? '-'}`);
        }
      }, opts.json);
      return;
    }
    let tokens = 0; let reasoning = 0; let sawReasoning = false; let ms = 0;
    const byStatus = new Map<string, number>();
    for (const r of rows) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      tokens += r.tokens ?? 0;
      if (r.tokensReasoning !== null && r.tokensReasoning !== undefined) {
        sawReasoning = true;
        reasoning += r.tokensReasoning;
      }
      ms += r.wallClockMs ?? 0;
    }
    const summary = {
      totalRuns: rows.length,
      byStatus: Object.fromEntries(byStatus.entries()),
      tokens,
      ...(sawReasoning ? { tokensReasoning: reasoning } : {}),
      wallClockMs: ms,
    };
    emit(summary, () => {
      console.log(`runs: ${rows.length} (${[...byStatus.entries()].map(([k, v]) => `${k}: ${v}`).join(', ')})`);
      console.log(`worker tokens consumed (≈ frontier tokens avoided, estimate): ${formatTokens(tokens, sawReasoning ? reasoning : undefined)}`);
      console.log(`worker wall-clock total: ${Math.round(ms / 1000)}s`);
      console.log('details: dlg gain --history');
    }, opts.json);
  });

defineCommand('clean [id]')
  .description('reclaim run disk: drop heavy worktrees and/or whole run dirs, prune stale git worktree entries')
  .option('--all', 'remove every finished (done) run entirely, receipts included')
  .option('--worktrees', 'free disk: drop the heavy checkouts of ALL runs (any state) but keep receipts so gain/result/apply still work')
  .action((id: string | undefined, opts: { all?: boolean; worktrees?: boolean; json?: boolean }) => {
    try {
      if (!id && !opts.all && !opts.worktrees) {
        console.error('pass a run id, --all (remove done runs), or --worktrees (free disk, keep receipts)');
        process.exit(2);
      }
      if (opts.worktrees) {
        const r = store.reapWorktrees();
        emit({ runId: id, dropped: r.dropped, freedMB: Math.round(r.freedBytes / 1048576), receiptsKept: true }, () => {
          console.log(`dropped ${r.dropped} heavy dir(s); freed ~${Math.round(r.freedBytes / 1048576)} MB; receipts kept`);
        }, opts.json);
        return;
      }
      const targets = opts.all
        ? store.listRuns().filter((m) => m.state === 'done')
        : (() => {
            if (!id) return [];
            const m = store.readMeta(id);
            if (m.state !== 'done') {
              console.error(`run ${id}: state is "${m.state}", not "done" — use \`dlg clean --worktrees\` to reclaim a non-done run's disk`);
              process.exit(1);
            }
            return [m];
          })();
      if (!targets.length) {
        emit({ runId: id, removed: [], freedMB: 0 }, () => {
          console.log(opts.all ? 'no done runs to clean' : `run ${id}: not found`);
        }, opts.json);
        return;
      }
      let freed = 0;
      const repos = new Set<string>();
      const removed: string[] = [];
      for (const m of targets) {
        if (m.worktree && fs.existsSync(m.worktree)) {
          freed += dirSizeBytes(path.dirname(m.worktree));
          try { removeWorktree(m.request.cwd, m.worktree); } catch { /* dir goes with removeRun below */ }
        }
        if (m.request?.cwd) repos.add(m.request.cwd);
        store.removeRun(m.id);
        removed.push(m.id);
      }
      for (const repo of repos) pruneWorktreeAdmin(repo);
      emit({ runId: id, removed, freedMB: Math.round(freed / 1048576) }, () => {
        for (const removedId of removed) console.log(`removed run: ${removedId}`);
        if (freed > 0) console.log(`freed ~${Math.round(freed / 1048576)} MB`);
      }, opts.json);
    } catch (e) { fail(e); }
  });

store.setRunsProject(process.cwd()); // runs are grouped per project (override: run --cwd)
maybeCheckForUpdate();
maybeAutoUpdateSkills();
program.parseAsync(process.argv).catch(fail);

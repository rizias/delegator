import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SpawnSpec } from './types.js';

// Cache of resolved binary paths (name → absolute path or null)
const binaryCache = new Map<string, string | null>();

export function resolveBinary(name: string): string | null {
  if (binaryCache.has(name)) return binaryCache.get(name)!;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, [name], { encoding: 'utf8' });
  const lines = result.status === 0
    ? result.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
    : [];
  // On Windows `where` may list an extensionless shim first (a bash script the
  // OS cannot spawn) - prefer real executables.
  const trimmed = process.platform === 'win32'
    ? (lines.find(l => /\.exe$/i.test(l)) ?? lines.find(l => /\.(cmd|bat)$/i.test(l)) ?? lines[0] ?? null)
    : (lines[0] ?? null);
  const resolved = process.platform === 'win32' ? preferExecutableSibling(trimmed) : trimmed;
  binaryCache.set(name, resolved);
  return resolved;
}

/** A PowerShell-only shim (e.g. `codex.ps1`) cannot be spawned directly on Windows — Node returns
 *  `spawn EPERM`. npm installs a runnable `.cmd` alongside the `.ps1`; prefer that (cmd.exe runs it).
 *  Returns the input unchanged when it isn't a `.ps1` or no runnable sibling exists (spawnStreaming
 *  then falls back to invoking PowerShell). Exported for testing. */
export function preferExecutableSibling(resolved: string | null): string | null {
  if (!resolved || !/\.ps1$/i.test(resolved)) return resolved;
  for (const ext of ['.cmd', '.bat', '.exe']) {
    const sibling = resolved.slice(0, -4) + ext;
    if (existsSync(sibling)) return sibling;
  }
  return resolved;
}

export interface SpawnedProc {
  pid: number;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
  killed: boolean;
}

// Host env var NAMES that look like a credential — stripped before a worker is spawned.
const CREDENTIAL_ENV =
  /API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|_KEY$|_PAT$/i;

/** The worker's environment: the host env MINUS credential-looking vars, then the worker's own
 *  spec.env layered back on. An untrusted worker therefore cannot read OTHER providers' API keys
 *  or host secrets (ARCHITECTURE: a worker gets only its own provider's credential), while PATH /
 *  HOME / system / CLI-config vars stay so the worker CLI still finds its own auth and runs. Its
 *  own provider key + equipment arrive via spec.env. (A stricter positive allowlist is a follow-up;
 *  a denylist avoids breaking worker auth by accidentally dropping a var the CLI needs.) */
export function workerEnv(specEnv?: Record<string, string>, preserveEnv?: string[]): NodeJS.ProcessEnv {
  const keep = preserveEnv ?? [];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Strip credential-looking host vars — UNLESS the spawning runtime owns this namespace
    // (subscription auth, e.g. claude's ANTHROPIC*/CLAUDE* login token). Those are this
    // worker's own credential; stripping them broke native Claude subscription with a 401.
    if (CREDENTIAL_ENV.test(k) && !keep.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return { ...out, ...specEnv };
}

export function spawnStreaming(
  spec: SpawnSpec,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
): SpawnedProc {
  const env = workerEnv(spec.env, spec.preserveEnv);

  // Resolve the binary to an absolute path so we can detect .cmd/.bat shims on Windows.
  // On Windows, npm-installed CLI tools (claude, codex) are .cmd wrappers. We cannot spawn
  // a .cmd file with shell:false reliably when forwarding args, so we invoke cmd.exe directly.
  let command = spec.command;
  let args = spec.args;
  let useShell = false;
  let windowsVerbatimArguments = false;

  const resolved = resolveBinary(spec.command);

  if (process.platform === 'win32' && resolved !== null) {
    const lower = resolved.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // Invoke via cmd.exe /d /s /c so arg quoting is handled by Windows natively.
      // This is the standard path for npm .cmd shims (claude.cmd, codex.cmd).
      command = process.env.ComSpec ?? 'cmd.exe';
      args = ['/d', '/s', '/c', resolved, ...spec.args];
      useShell = false;
      // Do NOT set windowsVerbatimArguments — we want Node to quote args normally.
    } else if (lower.endsWith('.ps1')) {
      // A PowerShell-only shim (resolveBinary found no runnable .cmd/.exe sibling). Node cannot
      // spawn a .ps1 directly (EPERM — on Windows, codex may install only as codex.ps1),
      // so run it through Windows PowerShell, which is always present.
      command = 'powershell.exe';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...spec.args];
      useShell = false;
    } else {
      // Direct executable (e.g. git.exe)
      command = resolved;
    }
  } else if (resolved !== null) {
    command = resolved;
  }

  const child = spawn(command, args, {
    cwd: spec.cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: [spec.stdinData !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: useShell,
    windowsVerbatimArguments,
  });

  if (spec.stdinData !== undefined && child.stdin) {
    child.stdin.write(spec.stdinData);
    child.stdin.end();
  }

  const pid = child.pid ?? 0;
  let _killed = false;

  const rl_stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const rl_stderr = createInterface({ input: child.stderr!, crlfDelay: Infinity });

  rl_stdout.on('line', (line) => onLine(line, 'stdout'));
  rl_stderr.on('line', (line) => onLine(line, 'stderr'));

  const waitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.on('error', (err) => {
        _killed = true;
        reject(err);
      });

      // Resolve on 'close' (not 'exit') so all stream data is flushed.
      child.on('close', (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    },
  );

  const proc: SpawnedProc = {
    get pid() {
      return pid;
    },
    wait() {
      return waitPromise;
    },
    get killed() {
      return _killed;
    },
  };

  return proc;
}

export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // Graceful first, then forced
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { encoding: 'utf8' });
    await new Promise<void>((r) => setTimeout(r, 3000));
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  } else {
    // POSIX: kill the entire process group (requires detached:true on spawn)
    const tryKill = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ESRCH') {
          // If process group kill fails (e.g. not a group leader), fall back to single PID
          try {
            process.kill(pid, sig);
          } catch (e2) {
            const err2 = e2 as NodeJS.ErrnoException;
            if (err2.code !== 'ESRCH') throw err2;
          }
        }
      }
    };

    tryKill('SIGTERM');
    await new Promise<void>((r) => setTimeout(r, 5000));
    tryKill('SIGKILL');
  }
}

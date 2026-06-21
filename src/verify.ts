import { spawnSync } from 'node:child_process';
import os from 'node:os';

import type { VerifySpec, VerifyCommand, VerificationResult, CmdResult } from './types.js';

/** Skipped with a human-readable reason — "skipped" alone reads as a bug. */
export function skippedBecause(reason: string): CmdResult {
  return { status: 'skipped', outputTail: reason };
}

function resolveCommand(
  spec: string | VerifyCommand | undefined,
): string | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === 'string') return spec;
  if (os.platform() === 'win32') {
    return spec.win ?? spec.command;
  }
  return spec.posix ?? spec.command;
}

function runCmd(
  cmd: string,
  wt: string,
  timeoutMs: number,
  shell?: string,
): CmdResult {
  const start = Date.now();
  let result: ReturnType<typeof spawnSync>;

  if (os.platform() === 'win32') {
    // Honor a configured shell on Windows too (was always powershell). powershell/pwsh take
    // -Command; an explicit POSIX shell (bash/sh on Git-bash/WSL) takes -c.
    const sh = shell ?? 'powershell';
    const usePosix = !!shell && !/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(sh);
    result = spawnSync(sh, usePosix ? ['-c', cmd] : ['-NoProfile', '-Command', cmd], {
      cwd: wt,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } else {
    result = spawnSync(shell ?? 'sh', ['-c', cmd], {
      cwd: wt,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  const durationMs = Date.now() - start;
  const combined = String(result.stdout ?? '') + String(result.stderr ?? '');
  const outputTail =
    combined.length > 2000
      ? combined.slice(combined.length - 2000)
      : combined;

  const exitCode = result.status ?? (result.error ? 1 : 0);
  const status: CmdResult['status'] = exitCode === 0 ? 'passed' : 'failed';

  return {
    status,
    exitCode,
    outputTail,
    durationMs,
  };
}

const SKIPPED: CmdResult = { status: 'skipped' };

export function runVerification(
  spec: VerifySpec | undefined,
  wt: string,
): VerificationResult {
  const timeoutMs = spec?.timeoutMs ?? 300_000;
  const noConfig = skippedBecause(
    'no verify.* commands configured — add build/test/lint to .delegator.yaml to verify patches',
  );

  function runStep(raw: string | VerifyCommand | undefined): CmdResult {
    const cmd = resolveCommand(raw);
    if (cmd === undefined) return noConfig;
    return runCmd(cmd, wt, timeoutMs, spec?.shell);
  }

  const build = runStep(spec?.build);
  const test = runStep(spec?.test);
  const lint = runStep(spec?.lint);

  return { build, test, lint };
}

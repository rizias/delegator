import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export function configHome(): string {
  return process.env.DELEGATOR_HOME ?? path.join(os.homedir(), '.delegator');
}

export const globalConfigPath = (): string => path.join(configHome(), 'providers.yaml');
export const runtimesConfigPath = (): string => path.join(configHome(), 'runtimes.yaml');
export const secretsPath = (): string => path.join(configHome(), 'secrets.yaml');
export const stateFilePath = (): string => path.join(configHome(), 'state.json');
export const updateCheckPath = (): string => path.join(configHome(), 'update-check.json');
export const runsJournalPath = (): string => path.join(configHome(), 'runs.jsonl');
export const projectsRoot = (): string => path.join(configHome(), 'projects');
// Legacy flat/grouped run root, kept only so old runs can still be read/cleaned.
export const runsRoot = (): string => path.join(configHome(), 'runs');

export const projectConfigPath = (cwd: string): string => path.join(cwd, '.delegator.yaml');

export function projectKey(repo: string): string {
  const resolved = path.resolve(repo);
  const hashInput = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 8);
  const base = path.basename(resolved)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/[-.]+$/g, '') || 'project';
  return `${base}-${hash}`;
}

export const projectDir = (repo: string): string => path.join(projectsRoot(), projectKey(repo));
export const projectRunDir = (repo: string, id: string): string => path.join(projectDir(repo), id);
export const worktreeDir = (repo: string, id: string): string => path.join(projectRunDir(repo, id), 'worktree');
export const workspaceDir = (repo: string, id: string): string => path.join(projectRunDir(repo, id), 'workspace');
export const pristineDir = (repo: string, id: string): string => path.join(projectRunDir(repo, id), 'pristine');

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Recursive on-disk size of a directory in bytes (best-effort; unreadable entries are skipped). */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      // skip unreadable entry
    }
  }
  return total;
}

export function tailOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return '…' + text.slice(text.length - maxChars);
}

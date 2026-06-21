// `dlg models [provider]` — list the models a provider CURRENTLY offers, fetched LIVE,
// never hardcoded. opencode's catalog is dynamic (changes without notice); API providers
// are queried at their /models endpoint. The CORE reads the key (never the agent/LLM) and
// puts it in the request header — the key value is never printed.
import { spawnSync } from 'node:child_process';
import { resolveBinary } from './proc.js';
import { loadSecretPools } from './config.js';
import { isLocalProvider } from './registry.js';
import type { DelegatorConfig, ProviderConfig } from './types.js';

function resolveKey(providerId: string, provider: ProviderConfig): string | undefined {
  const pool = loadSecretPools()[providerId];
  if (pool && pool.length) return pool[0];
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv];
  return undefined;
}

export interface ModelsResult {
  provider: string;
  kind: string;
  models: string[];
  note?: string;   // why the list is empty / partial (no key, no endpoint, etc.)
  source?: 'running' | 'models';
}

export interface FetchProviderModelsOptions {
  preferRunning?: boolean;
}

function runningModelsUrl(base: string): string {
  const root = base.replace(/\/v1$/i, '');
  return `${root}/api/ps`;
}

async function fetchRunningModels(base: string, headers: Record<string, string>): Promise<string[] | undefined> {
  const url = runningModelsUrl(base);
  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch {
    return undefined;
  }
  if (!resp.ok) return undefined;
  let json: { models?: Array<{ name?: string }> };
  try {
    json = (await resp.json()) as { models?: Array<{ name?: string }> };
  } catch {
    return undefined;
  }
  const arr = json.models ?? [];
  return arr.map((m) => m.name).filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export async function fetchProviderModels(
  providerId: string,
  cfg: DelegatorConfig,
  options: FetchProviderModelsOptions = {},
): Promise<ModelsResult> {
  const provider = cfg.providers[providerId];
  if (!provider) throw new Error(`unknown provider "${providerId}" (known: ${Object.keys(cfg.providers).join(', ')})`);
  const kind = provider.kind;

  // opencode: DYNAMIC catalog — always fetch from the CLI, never hardcode (the list
  // changes: new free models appear, others vanish).
  if (kind === 'opencode') {
    const bin = resolveBinary('opencode') ?? 'opencode';
    const r = spawnSync(bin, ['models'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const out = String(r.stdout ?? '') + String(r.stderr ?? '');
    const models = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.includes(' '));
    if (!models.length) return { provider: providerId, kind, models: [], note: 'opencode returned no models — is it installed and authenticated? (run: opencode models)' };
    return { provider: providerId, kind, models };
  }

  // codex authenticates via its own CLI/plan; there is no key here to query a /models API.
  if (kind === 'codex-cli') {
    return { provider: providerId, kind, models: [], note: 'codex authenticates via the codex CLI / your ChatGPT plan — no /models endpoint to query here. Confirm available model ids in the Codex docs.' };
  }

  // Local providers (ollama, lmstudio, … served on localhost) never need a key:
  // they answer /models unauthenticated. A connection failure (server not running)
  // is a fine, expected outcome here — a KEY error for one of these is the bug.
  const isLocal = isLocalProvider(provider);
  const noKeyNeeded = isLocal || provider.auth === 'none' || provider.auth === 'subscription';
  const key = resolveKey(providerId, provider);
  if (!key && !noKeyNeeded) {
    return { provider: providerId, kind, models: [], note: `no API key for "${providerId}" — cannot query its models. Add one: dlg key set ${providerId}` };
  }
  const base = (provider.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return { provider: providerId, kind, models: [], note: `provider "${providerId}" has no baseUrl to query` };

  let url: string;
  const headers: Record<string, string> = {};
  if (kind === 'anthropic' || kind === 'anthropic-compatible') {
    url = `${base}/v1/models`;
    if (key) { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  } else { // openai-compatible (baseUrl already ends in /v1)
    url = `${base}/models`;
    if (key && !isLocal) headers['authorization'] = `Bearer ${key}`;
  }

  if (kind === 'openai-compatible' && options.preferRunning) {
    const running = await fetchRunningModels(base, headers);
    if (running !== undefined && running.length > 0) {
      return { provider: providerId, kind, models: running, source: 'running' };
    }
  }

  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    return { provider: providerId, kind, models: [], note: `could not reach ${url}: ${String(e instanceof Error ? e.message : e)}` };
  }
  if (!resp.ok) {
    return { provider: providerId, kind, models: [], note: `${url} → HTTP ${resp.status}; this provider may not expose a /models list.` };
  }
  const json = (await resp.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
  const arr = json.data ?? json.models ?? [];
  const models = arr.map((m) => m.id).filter((x): x is string => typeof x === 'string').sort();
  return { provider: providerId, kind, models, source: 'models' };
}

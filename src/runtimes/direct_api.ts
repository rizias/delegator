import { classifyFailure, parseRetryAfter } from '../classify.js';
import { ConfigError } from '../config.js';
import { getResponseParser, parseResponseByName } from '../parsers/registry.js';
import { isLocalProvider } from '../registry.js';
import type {
  InProcessFailure,
  InProcessResult,
  InProcessRuntime,
  RuntimeContext,
  RuntimeDescriptor,
} from '../types.js';
import {
  placeholderValues,
  renderTemplate,
  hasEmptyPlaceholder,
  validateDescriptorTokens,
} from './factory.js';

export interface DirectApiRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function buildDirectApiRequest(
  id: string,
  descriptor: RuntimeDescriptor,
  ctx: RuntimeContext,
): DirectApiRequest {
  if (!descriptor.request) throw new ConfigError(`Runtime "${id}" is missing request`);
  validateDescriptorTokens(id, descriptor);

  const values = placeholderValues(id, ctx);
  const base = (ctx.resolved.provider.baseUrl ?? '').replace(/\/+$/, '');
  const path = descriptor.request.path.startsWith('/')
    ? descriptor.request.path
    : `/${descriptor.request.path}`;
  const headers: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(descriptor.request.headers ?? {})) {
    const key = rawKey.toLowerCase();
    if (key === 'authorization' && isLocalProvider(ctx.resolved.provider)) continue;
    if (hasEmptyPlaceholder(rawValue, values)) continue;
    const value = renderTemplate(rawValue, values);
    if (value !== '') headers[key] = value;
  }

  const body = JSON.stringify(deepRender(descriptor.request.json ?? {}, values));
  return {
    url: `${base}${path}`,
    method: descriptor.request.method,
    headers,
    body,
  };
}

export function directApiRuntimeFromDescriptor(
  id: string,
  descriptor: RuntimeDescriptor,
): InProcessRuntime {
  const parserName = descriptor.output?.parser ?? descriptor.request?.output?.parser ?? descriptor.parser;
  if (!parserName || parserName === 'none') {
    throw new ConfigError(`Runtime "${id}" is missing output.parser`);
  }
  getResponseParser(parserName); // validate the parser id NOW — a clear error at load, not cryptically mid-run
  validateDescriptorTokens(id, descriptor);

  return {
    id,

    async execute(ctx, opts): Promise<InProcessResult> {
      const req = buildDirectApiRequest(id, descriptor, ctx);
      const base = (ctx.resolved.provider.baseUrl ?? '').replace(/\/+$/, '') || req.url;
      const fetchImpl = opts.fetchImpl ?? fetch;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);

      let resp: Response;
      try {
        resp = await fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = String(e instanceof Error ? e.message : e);
        if (e instanceof Error && e.name === 'AbortError') {
          return {
            status: 'failed',
            summary: `could not reach ${base}: request timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
            stopReason: `${id}: request timed out after ${Math.round(opts.timeoutMs / 1000)}s (wall-clock budget)`,
            errType: 'timeout',
            failure: null,
          };
        }
        const verdict = classifyFailure(msg);
        const failure: InProcessFailure = verdict
          ? failureFrom(verdict)
          : { class: 'server', errType: 'server', reason: `could not reach ${base}: ${msg}` };
        return {
          status: 'failed',
          summary: `could not reach ${base}: ${msg}`,
          stopReason: `${id}: could not reach ${base} - ${msg}`,
          errType: 'server',
          failure,
        };
      }
      // NOTE: the timer stays armed through the body read below — a server that sends headers
      // then stalls on the body must still hit the wall-clock budget, not hang forever.

      if (!resp.ok) {
        let bodyText = '';
        try { bodyText = await resp.text(); } catch { bodyText = ''; }
        clearTimeout(timer); // error body consumed — disarm the abort timer
        const failure = classifyHttp(resp.status, `HTTP ${resp.status}\n${bodyText}`);
        if (failure) {
          const ra = resp.headers?.get?.('retry-after');
          if (ra && failure.retryAfterMs === undefined) {
            const ms = parseRetryAfter(`retry-after: ${ra}`);
            if (ms !== undefined) failure.retryAfterMs = ms;
          }
          return {
            status: 'failed',
            summary: `${base} rejected the request: ${failure.reason}`,
            stopReason: `${id}: ${failure.reason}`,
            errType: failure.errType,
            failure,
          };
        }
        const snippet = bodyText.trim().slice(0, 300);
        return {
          status: 'failed',
          summary: `${base} returned HTTP ${resp.status}${snippet ? `: ${snippet}` : ''}`,
          stopReason: `${id}: ${base} returned HTTP ${resp.status}`,
          errType: 'server',
          failure: null,
        };
      }

      let json: unknown;
      try {
        json = await resp.json();
        clearTimeout(timer); // body fully read — disarm the abort timer
      } catch (e) {
        clearTimeout(timer);
        const msg = String(e instanceof Error ? e.message : e);
        if (e instanceof Error && e.name === 'AbortError') {
          return {
            status: 'failed',
            summary: `${base} stalled sending the response body: timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
            stopReason: `${id}: response body timed out after ${Math.round(opts.timeoutMs / 1000)}s (wall-clock budget)`,
            errType: 'timeout',
            failure: null,
          };
        }
        return {
          status: 'failed',
          summary: `could not parse response from ${base}: ${msg}`,
          stopReason: `${id}: response from ${base} was not valid JSON (${msg})`,
          errType: 'server',
          failure: null,
        };
      }

      const { summary, tokens } = parseResponseByName(parserName, json);
      if (!summary) {
        return {
          status: 'failed',
          summary: `${base} returned an empty reply (no parsed message content)`,
          stopReason: `${id}: response had no message content`,
          errType: 'server',
          failure: null,
        };
      }
      return {
        status: 'completed',
        summary,
        stopReason: `${id}: direct API call succeeded`,
        errType: 'server',
        ...(tokens ? { tokens } : {}),
        failure: null,
      };
    },
  };
}

function deepRender(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string') return renderTemplate(value, values);
  if (Array.isArray(value)) return value.map((item) => deepRender(item, values));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepRender(item, values);
    }
    return out;
  }
  return value;
}

function classifyHttp(status: number, bodyText: string): InProcessFailure | null {
  const verdict = classifyFailure(`${status}\n${bodyText}`);
  if (!verdict) return null;
  return failureFrom(verdict);
}

function failureFrom(verdict: NonNullable<ReturnType<typeof classifyFailure>>): InProcessFailure {
  return {
    class: verdict.class,
    errType: verdict.errType,
    reason: verdict.reason,
    ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
    ...(verdict.retryAfterMs !== undefined ? { retryAfterMs: verdict.retryAfterMs } : {}),
  };
}

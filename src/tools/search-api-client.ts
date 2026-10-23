/**
 * Apple JSONL search API client
 *
 * Ported function-by-function from apple-search-mcp/server.py (the verified
 * Python reference implementation). The legacy HTML scraping in this repo
 * returned zero results after Apple moved the search page to a JS frontend;
 * this client talks to the real backend:
 *
 *   POST https://devintserv.msc.sbz.apple.com/api/v1/query
 *
 * WARNING: this endpoint is an undocumented Apple interface and may change.
 * Callers must surface failures explicitly — never silently report "no results".
 *
 * The endpoint is a *progressive* JSONL stream: Apple emits `quickSearch`
 * metadata first and then delivers the real result set as a series of `search`
 * diff events. Waiting for the stream to finish with `response.text()` is what
 * made calls take 10-20s and hard-fail at the old 20s timeout. The product
 * path therefore reads the body incrementally, keeps whatever was parsed, and
 * returns partial results when the stream stalls.
 */

import { UserAgentPool } from '../utils/user-agent-pool.js';
import { searchCache } from '../utils/cache.js';
import { REQUEST_CONFIG, SAFARI_USER_AGENTS } from '../utils/constants.js';
import type {
  AppleSearchApiResult,
  AppleSearchMetadata,
  AppleSearchStreamItem,
} from '../types/search.js';

export const API_URL = 'https://devintserv.msc.sbz.apple.com/api/v1/query';

/**
 * Required request headers for Apple's search backend.
 * Mirrors HEADERS in server.py (Origin/Referer are mandatory).
 */
export const SEARCH_API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Accept': 'application/jsonl',
  'Origin': 'https://developer.apple.com',
  'Referer': 'https://developer.apple.com/search/',
};

/**
 * Overall request budget in milliseconds.
 *
 * Apple's own frontend applies a 120s idle timeout to this stream, so the old
 * 20s cap was far too aggressive: it clipped a meaningful share of normal
 * calls (measured p50 ≈ 11.8s, tail 20-40s).
 */
export const SEARCH_API_TIMEOUT_MS = 35000;

/**
 * Idle budget: no bytes for this long means the stream stalled. Whatever was
 * parsed by then is returned as a partial result instead of an error.
 */
export const SEARCH_API_IDLE_TIMEOUT_MS = 15000;

/**
 * Upper bound on results returned to callers. Apple's endpoint caps at ~20
 * per query (observed 15-22) regardless of any client-side limit, and rejects
 * `limit`/`page`/`offset`/`cursor` body fields with HTTP 400.
 */
export const SEARCH_API_MAX_RESULTS = 20;

/**
 * Supported `search_scope` names, mapped to Apple's scope-object DSL.
 *
 * Apple rejects a plain string with HTTP 400 (20/20 tested values). It accepts
 * structured scope objects instead (`getSearchScope` in Apple's search.js).
 * Note this is a site-path / documentation-role filter — framework filtering
 * ("swiftui") is not expressible in this DSL.
 */
export const SEARCH_SCOPES = {
  documentation: {
    kind: 'and',
    scopes: [
      { kind: 'hostname', value: 'developer.apple.com' },
      { kind: 'pathPrefix', value: '/documentation/' },
    ],
  },
  video: {
    kind: 'and',
    scopes: [
      { kind: 'hostname', value: 'developer.apple.com' },
      { kind: 'pathPrefix', value: '/videos/play/' },
    ],
  },
  sample_code: { kind: 'documentationRole', value: 'sampleCode' },
  wwdc26: {
    kind: 'or',
    scopes: [
      { kind: 'pathPrefix', value: '/wwdc26/' },
      { kind: 'pathPrefix', value: '/videos/play/wwdc26/' },
    ],
  },
} as const;

export type AppleSearchScopeName = keyof typeof SEARCH_SCOPES;

/**
 * Resolve the public `search_scope` argument to an Apple scope object.
 * Throws on unsupported values so callers get an actionable error instead of
 * a bare HTTP 400 from the backend.
 */
export function resolveSearchScope(searchScope?: string): unknown {
  const scope = (searchScope ?? '').trim();
  if (!scope) {
    return undefined;
  }
  if (!(scope in SEARCH_SCOPES)) {
    throw new Error(
      `Unsupported search_scope "${scope}". Supported values: ${Object.keys(SEARCH_SCOPES).join(', ')} (framework filtering is not supported by Apple's search backend).`,
    );
  }
  return SEARCH_SCOPES[scope as AppleSearchScopeName];
}

/**
 * Retry policy for the legacy text request (postQuery): retry server errors
 * (5xx) and rate limiting (429) with exponential backoff. Client errors
 * (4xx other than 429) are deterministic and fail immediately.
 *
 * Timeouts are never retried — a timeout already consumed the whole budget.
 */
export const SEARCH_API_MAX_RETRIES = REQUEST_CONFIG.MAX_RETRIES;
export const SEARCH_API_RETRY_DELAY_MS = REQUEST_CONFIG.RETRY_DELAY;

/**
 * Default result-title locale. Apple silently falls back to en-US for
 * unsupported values, so this is a plain string rather than an enum.
 */
export const SEARCH_API_DEFAULT_LOCALE = 'en-US';

/**
 * Cache key for a search query (the 10-minute TTL comes from `searchCache`).
 * The locale is part of the key: the same query returns localized WWDC titles
 * for zh-CN/ja-JP/ko-KR, so mixing them would poison the cache.
 */
function searchCacheKey(query: string, searchScope: string, locale: string): string {
  return `search:${locale}:${searchScope}:${query.trim().toLowerCase()}`;
}

/** Drop cached search results (used by tests and diagnostics). */
export function clearSearchCache(): void {
  searchCache.clear();
}

/**
 * Read a numeric env override (used by tests to keep the suite fast, and by
 * operators to tune/disable retries without code changes).
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Effective timeouts (env-overridable so tests can exercise the stall path). */
function overallTimeoutMs(): number {
  return envNumber('SEARCH_API_TIMEOUT_MS', SEARCH_API_TIMEOUT_MS);
}

function idleTimeoutMs(): number {
  return envNumber('SEARCH_API_IDLE_TIMEOUT_MS', SEARCH_API_IDLE_TIMEOUT_MS);
}

/** HTTP statuses worth retrying (transient server-side conditions). */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// User-Agent pool (shared by the text and streaming request paths)
// ---------------------------------------------------------------------------

let searchUaPool: UserAgentPool | null = null;

function getSearchUaPool(): UserAgentPool {
  if (!searchUaPool) {
    searchUaPool = new UserAgentPool([...SAFARI_USER_AGENTS], {
      strategy: 'random',
      disableDuration: 5 * 60 * 1000, // 5 minutes
      failureThreshold: 3,
      minSuccessRate: 0.5,
    });
  }
  return searchUaPool;
}

async function pickUserAgent(): Promise<string> {
  try {
    const agent = await getSearchUaPool().getNextUserAgent();
    return agent.userAgent;
  } catch (error) {
    console.warn('Search User-Agent pool failed, falling back to static User-Agent:', error);
    return REQUEST_CONFIG.DEFAULT_SAFARI_USER_AGENT || REQUEST_CONFIG.USER_AGENT;
  }
}

/** Build the request body for a query. */
function buildQueryBody(
  query: string,
  searchScope: unknown,
  locale: string = SEARCH_API_DEFAULT_LOCALE,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: query,
    targetResultLocale: locale,
    includedResponses: ['quickSearch', 'search'],
  };
  if (searchScope) {
    body.searchScope = searchScope;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Legacy text request (kept for direct callers/tests; the product path streams)
// ---------------------------------------------------------------------------

/**
 * POST the query to Apple's search backend and return the raw JSONL payload.
 *
 * Kept as the non-streaming fallback (and for direct callers/tests). The
 * product path uses {@link streamQuery} so partial results survive a stall.
 */
export async function postQuery(
  query: string,
  searchScope: string = '',
  locale: string = SEARCH_API_DEFAULT_LOCALE,
): Promise<string> {
  const body = buildQueryBody(query, resolveSearchScope(searchScope), locale);

  const maxRetries = envNumber('SEARCH_API_MAX_RETRIES', SEARCH_API_MAX_RETRIES);
  const retryDelayMs = envNumber('SEARCH_API_RETRY_DELAY_MS', SEARCH_API_RETRY_DELAY_MS);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const userAgent = await pickUserAgent();
    let statusCode: number | undefined;

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          ...SEARCH_API_HEADERS,
          'User-Agent': userAgent,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(overallTimeoutMs()),
      });
      statusCode = response.status;

      if (!response.ok) {
        throw new Error(`Apple search backend returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      }

      const text = await response.text();
      await getSearchUaPool().markSuccess(userAgent);
      return text;
    } catch (error) {
      await getSearchUaPool().markFailure(userAgent, statusCode).catch(() => {
        // Pool feedback is best-effort; never mask the original error.
      });

      lastError = error instanceof Error ? error : new Error(String(error));

      // A timeout is a timeout — no point burning more attempts.
      if (isTimeoutFailure(lastError)) {
        throw new Error(`Apple search backend request timed out after ${SEARCH_API_TIMEOUT_MS / 1000}s`);
      }

      // Deterministic client errors (400/403/404/...) fail fast, unretried.
      if (statusCode !== undefined && !isRetryableStatus(statusCode)) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }
  }

  throw lastError ?? new Error('Apple search backend request failed after retries');
}

// ---------------------------------------------------------------------------
// Streaming request
// ---------------------------------------------------------------------------

/** Why the stream stopped early (null = completed normally). */
export type SearchStreamAbortReason = 'idle' | 'overall' | null;

/** A single streaming attempt's raw outcome. */
export interface SearchStreamOutcome {
  /** Complete JSONL lines received so far (a partial trailing line is dropped). */
  lines: string[];
  /** Set when the client aborted the request; null when the stream finished. */
  abortReason: SearchStreamAbortReason;
}

class SearchHttpError extends Error {
  public readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Apple search backend returned HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'SearchHttpError';
    this.status = status;
  }
}

/** True for Node's `TimeoutError` and the browser/undici `AbortError`. */
function isTimeoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error.message.includes('timed out')
    || error.message.includes('The operation was aborted');
}

/**
 * One streaming attempt: POST the query and consume the JSONL body as it
 * arrives, extending the idle timer on every chunk.
 *
 * Returns partial data (with `abortReason` set) instead of throwing when the
 * client aborts on idle/overall timeout. HTTP and network failures throw.
 */
async function streamAttempt(
  query: string,
  searchScope: unknown,
  userAgent: string,
  locale: string = SEARCH_API_DEFAULT_LOCALE,
): Promise<SearchStreamOutcome> {
  const controller = new AbortController();
  let abortReason: SearchStreamAbortReason = null;
  let idleTimer: NodeJS.Timeout | undefined;

  const abort = (reason: SearchStreamAbortReason): void => {
    if (!abortReason) {
      abortReason = reason;
      controller.abort();
    }
  };
  const resetIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => abort('idle'), idleTimeoutMs());
  };
  const overallTimer = setTimeout(() => abort('overall'), overallTimeoutMs());
  resetIdleTimer();

  const lines: string[] = [];

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        ...SEARCH_API_HEADERS,
        'User-Agent': userAgent,
      },
      body: JSON.stringify(buildQueryBody(query, searchScope, locale)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new SearchHttpError(response.status, response.statusText ?? '');
    }

    // Test doubles (and some proxies) expose text() but not a readable body.
    if (!response.body) {
      const text = await response.text();
      return { lines: text.split('\n'), abortReason: null };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (abortReason) {
          break;
        }
        throw error;
      }

      if (chunk.done) {
        break;
      }

      resetIdleTimer();
      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }

    if (buffer.trim()) {
      lines.push(buffer);
    }

    return { lines, abortReason };
  } catch (error) {
    if (abortReason) {
      // Aborted by our own timers: hand back what already arrived.
      return { lines, abortReason };
    }
    throw error;
  } finally {
    clearTimeout(overallTimer);
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}

/**
 * Stream the query with retries for transient HTTP/network failures.
 *
 * Timeouts and idle stalls are *not* retried: they already consumed the
 * budget and partial data is returned instead.
 */
async function streamQuery(
  query: string,
  searchScope: string,
  locale: string = SEARCH_API_DEFAULT_LOCALE,
): Promise<SearchStreamOutcome> {
  const scope = resolveSearchScope(searchScope);
  const maxRetries = envNumber('SEARCH_API_MAX_RETRIES', SEARCH_API_MAX_RETRIES);
  const retryDelayMs = envNumber('SEARCH_API_RETRY_DELAY_MS', SEARCH_API_RETRY_DELAY_MS);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const userAgent = await pickUserAgent();
    try {
      const outcome = await streamAttempt(query, scope, userAgent, locale);
      await getSearchUaPool().markSuccess(userAgent);
      return outcome;
    } catch (error) {
      const status = error instanceof SearchHttpError ? error.status : undefined;
      await getSearchUaPool().markFailure(userAgent, status).catch(() => {
        // Pool feedback is best-effort; never mask the original error.
      });

      lastError = error instanceof Error ? error : new Error(String(error));

      if (isTimeoutFailure(lastError)) {
        throw new Error(`Apple search backend request timed out after ${overallTimeoutMs() / 1000}s`);
      }

      if (status !== undefined && !isRetryableStatus(status)) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }
  }

  throw lastError ?? new Error('Apple search backend request failed after retries');
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Event shapes that prove the payload still speaks the expected protocol.
 * `quickSearchFinished` / `searchFinished` are control markers with no
 * payload of their own, but a stream consisting solely of unknown shapes
 * means Apple changed the format — that must error out, never surface as a
 * silent "No results".
 */
const KNOWN_CONTROL_EVENTS = new Set(['quickSearch', 'quickSearchFinished', 'searchFinished']);

interface CollectedEvents {
  quick: AppleSearchMetadata[];
  searchBuf: string;
  validEvents: number;
  recognizedEvents: number;
}

/** Apply a single `search` diff event to the sliding JSON buffer. */
function applySearchDiff(searchBuf: string, diff: unknown): string {
  const { removeLast = 0, append = '' } = (diff ?? {}) as { removeLast?: number; append?: string };
  const trimmed = removeLast > 0
    ? searchBuf.slice(0, Math.max(0, searchBuf.length - removeLast))
    : searchBuf;
  return trimmed + append;
}

/** Extract result metadata entries from a `quickSearch` event. */
function extractQuickResults(event: Record<string, unknown>): AppleSearchMetadata[] {
  const response = (event.response ?? {}) as { results?: Array<{ metadata?: AppleSearchMetadata }> };
  return (response.results ?? []).map(item => item.metadata ?? {});
}

/** Fold JSONL lines into the quickSearch results and the rebuilt search buffer. */
function collectEvents(rawLines: string[]): CollectedEvents {
  const quick: AppleSearchMetadata[] = [];
  let searchBuf = '';
  let validEvents = 0;
  let recognizedEvents = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip unparseable lines (same tolerance as the Python port)
    }
    validEvents++;

    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'quickSearch') {
      recognizedEvents++;
      quick.push(...extractQuickResults(event));
    } else if (KNOWN_CONTROL_EVENTS.has(kind)) {
      recognizedEvents++;
    } else if ('diff' in event) {
      recognizedEvents++;
      searchBuf = applySearchDiff(searchBuf, event.diff);
    }
  }

  return { quick, searchBuf, validEvents, recognizedEvents };
}

/**
 * Parse the rebuilt `search` document. When `tolerant` is set (partial stream)
 * an unparseable buffer is treated as "no search results yet" rather than an
 * error, because the stream was cut mid-flight.
 */
function finalizeSearchBuffer(
  searchBuf: string,
  quick: AppleSearchMetadata[],
  tolerant: boolean,
): AppleSearchStreamItem[] {
  if (!searchBuf.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(searchBuf) as { results?: AppleSearchStreamItem[] };
    return parsed.results ?? [];
  } catch {
    if (tolerant || quick.length > 0) {
      return [];
    }
    throw new Error('Failed to rebuild search results from the JSONL diff stream: final buffer was not valid JSON. The response format may have changed.');
  }
}

/**
 * Parse Apple's search JSONL payload:
 * `quickSearch` events carry full result arrays; `search` results arrive as a
 * stream of incremental diff events — for each diff event, remove the last
 * `removeLast` characters from the buffer, then append the `append` fragment.
 * After all events, the rebuilt buffer is parsed as a single JSON document.
 *
 * Throws when the payload contains no parseable JSONL events at all, when it
 * contains none of the known protocol event shapes (response shape changed),
 * or when the rebuilt search buffer is unparseable and no quickSearch
 * results exist.
 */
export function parseJsonl(payload: string): { quick: AppleSearchMetadata[]; search: AppleSearchStreamItem[] } {
  const { quick, searchBuf, validEvents, recognizedEvents } = collectEvents(payload.split('\n'));

  if (validEvents === 0) {
    throw new Error('Failed to parse Apple search response: payload contained no valid JSONL events. The response format may have changed.');
  }

  if (recognizedEvents === 0) {
    throw new Error('Failed to parse Apple search response: payload contained no recognized Apple search events (expected quickSearch, diff or *Finished markers). The response format may have changed.');
  }

  const search = finalizeSearchBuffer(searchBuf, quick, false);
  return { quick, search };
}

// ---------------------------------------------------------------------------
// Result normalization / merging
// ---------------------------------------------------------------------------

/** First defined non-empty string of the candidates. */
function firstString(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return '';
}

/**
 * Normalize one metadata object into the renderer's result shape.
 *
 * `documentation` items carry scalar title/permalink/…; `developer` (WWDC
 * videos/collections) carry plural arrays (`titles`, `permalinks`,
 * `descriptions`, `itemTypes`, …); `webPage`/`pdf` carry `sourceURL` instead
 * of `permalink`. Ignoring those shapes is what produced blank titles.
 */
export function normalizeSearchResult(
  meta: AppleSearchMetadata,
  excerpt?: string,
): AppleSearchApiResult | null {
  const title = firstString(meta.title, meta.titles?.[0]);
  const permalink = firstString(meta.permalink, meta.permalinks?.[0], meta.sourceURL);
  const description = firstString(excerpt, meta.description, meta.descriptions?.[0]);
  const hierarchy = firstString(meta.hierarchy, meta.projectNames?.[0]);
  const availability = firstString(meta.availability, meta.availabilityDates?.[0]);
  const type = firstString(meta.kind, meta.itemTypes?.[0], meta.metadataKind);

  const fallbackTitle = permalink ? decodeURIComponent(permalink.split('/').filter(Boolean).pop() ?? '') : '';
  const usableTitle = title || fallbackTitle;

  if (!usableTitle && !permalink) {
    return null;
  }

  return {
    title: usableTitle,
    description,
    availability,
    hierarchy,
    permalink,
    type,
  };
}

/**
 * Merge quickSearch and search results, deduplicated by permalink/URL.
 * `search` entries are pushed first (they carry the hit excerpt, which takes
 * precedence over the plain description).
 */
export function dedupeMerge(
  quick: AppleSearchMetadata[],
  search: AppleSearchStreamItem[],
  limit: number,
): AppleSearchApiResult[] {
  const merged: AppleSearchApiResult[] = [];
  const seen = new Set<string>();

  const push = (meta: AppleSearchMetadata, excerpt?: string): void => {
    const normalized = normalizeSearchResult(meta, excerpt);
    if (!normalized) {
      return;
    }
    const key = normalized.permalink || normalized.title.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(normalized);
  };

  for (const item of search) {
    push(item.value?.metadata ?? {}, item.excerpt);
  }
  for (const meta of quick) {
    push(meta);
  }

  return merged.slice(0, Math.max(1, Math.min(limit, SEARCH_API_MAX_RESULTS)));
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Detailed search outcome, including whether the stream was cut short. */
export interface AppleSearchResultSet {
  results: AppleSearchApiResult[];
  /** True when the backend stream stalled and only partial data is present. */
  partial: boolean;
  /** Human-readable reason for a partial result set. */
  partialReason?: string;
  /** True when the result came from the in-process cache. */
  cached: boolean;
}

/**
 * Search Apple docs, streaming the JSONL body and keeping partial results.
 *
 * Returns `partial: true` when the stream stalled before `searchFinished`;
 * `partialReason` is suitable for surfacing to the caller.
 */
export async function searchAppleDocsApiDetailed(
  query: string,
  limit: number = 10,
  searchScope: string = '',
  locale: string = SEARCH_API_DEFAULT_LOCALE,
): Promise<AppleSearchResultSet> {
  const cacheKey = searchCacheKey(query, searchScope, locale);
  const cached = searchCache.get<AppleSearchApiResult[]>(cacheKey);
  if (cached) {
    return {
      results: cached.slice(0, Math.max(1, Math.min(limit, SEARCH_API_MAX_RESULTS))),
      partial: false,
      cached: true,
    };
  }

  const outcome = await streamQuery(query, searchScope, locale);
  const { quick, searchBuf, validEvents, recognizedEvents } = collectEvents(outcome.lines);
  const partial = outcome.abortReason !== null;

  if (!partial) {
    if (validEvents === 0) {
      throw new Error('Failed to parse Apple search response: payload contained no valid JSONL events. The response format may have changed.');
    }
    if (recognizedEvents === 0) {
      throw new Error('Failed to parse Apple search response: payload contained no recognized Apple search events (expected quickSearch, diff or *Finished markers). The response format may have changed.');
    }
  }

  const search = finalizeSearchBuffer(searchBuf, quick, partial);
  const results = dedupeMerge(quick, search, limit);

  if (partial) {
    const reason = outcome.abortReason === 'idle'
      ? `the backend stream stalled for ${idleTimeoutMs() / 1000}s`
      : `the request exceeded ${overallTimeoutMs() / 1000}s`;
    return {
      results,
      partial: true,
      partialReason: `Partial results: ${reason}; only ${results.length} result(s) could be parsed and the result set may be incomplete.`,
      cached: false,
    };
  }

  searchCache.set(cacheKey, results);
  return { results, partial: false, cached: false };
}

/**
 * Main entry (port of server.py search_apple_docs): request, parse and merge.
 * Returns up to `limit` (clamped to the backend's practical maximum of 20)
 * deduplicated results.
 *
 * Throws on HTTP errors, network errors and JSONL parse failures — callers
 * must convert thrown errors into explicit isError responses.
 */
export async function searchAppleDocsApi(
  query: string,
  limit: number = 10,
  searchScope: string = '',
  locale: string = SEARCH_API_DEFAULT_LOCALE,
): Promise<AppleSearchApiResult[]> {
  const { results } = await searchAppleDocsApiDetailed(query, limit, searchScope, locale);
  return results;
}

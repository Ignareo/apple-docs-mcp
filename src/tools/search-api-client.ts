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
 * @author Apple Docs MCP
 * @version 1.0.0
 */

import { randomUUID } from 'node:crypto';
import { UserAgentPool } from '../utils/user-agent-pool.js';
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
 * Request timeout in milliseconds (TIMEOUT_S = 20 in server.py).
 */
export const SEARCH_API_TIMEOUT_MS = 20000;

/**
 * Maximum number of results the backend is asked to return per query
 * (server.py clamps limit to [1, 30]).
 */
export const SEARCH_API_MAX_RESULTS = 30;

// Module-level User-Agent pool instance, mirroring the pool used by
// utils/http-client.ts (initializeUserAgentPool).
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

/**
 * Pick a User-Agent from the shared Safari User-Agent pool.
 * Falls back to the configured default agent if the pool is unavailable.
 */
async function pickUserAgent(): Promise<string> {
  try {
    const agent = await getSearchUaPool().getNextUserAgent();
    return agent.userAgent;
  } catch (error) {
    console.warn('Search User-Agent pool failed, falling back to static User-Agent:', error);
    return REQUEST_CONFIG.DEFAULT_SAFARI_USER_AGENT || REQUEST_CONFIG.USER_AGENT;
  }
}

/**
 * POST the query to Apple's search backend and return the raw JSONL payload.
 * Throws on network errors, timeouts and non-2xx HTTP statuses.
 */
export async function postQuery(query: string, searchScope: string = ''): Promise<string> {
  const body: Record<string, unknown> = {
    text: query,
    targetResultLocale: 'en-US',
    includedResponses: ['quickSearch', 'search'],
  };
  if (searchScope) {
    body.searchScope = searchScope;
  }

  const userAgent = await pickUserAgent();

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      ...SEARCH_API_HEADERS,
      'User-Agent': userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEARCH_API_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Apple search backend returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }

  return response.text();
}

/**
 * Apply a single `search` diff event: drop the last `removeLast` characters
 * from the buffer, then append the `append` fragment.
 */
function applySearchDiff(searchBuf: string, diff: unknown): string {
  const { removeLast = 0, append = '' } = (diff ?? {}) as { removeLast?: number; append?: string };
  const trimmed = removeLast > 0
    ? searchBuf.slice(0, Math.max(0, searchBuf.length - removeLast))
    : searchBuf;
  return trimmed + append;
}

/**
 * Extract result metadata entries from a `quickSearch` event
 * (`event.response.results[].metadata`).
 */
function extractQuickResults(event: Record<string, unknown>): AppleSearchMetadata[] {
  const response = (event.response ?? {}) as { results?: Array<{ metadata?: AppleSearchMetadata }> };
  return (response.results ?? []).map(item => item.metadata ?? {});
}

/**
 * Parse Apple's search JSONL payload:
 * `quickSearch` events carry full result arrays; `search` results arrive as a
 * stream of incremental diff events — for each diff event, remove the last
 * `removeLast` characters from the buffer, then append the `append` fragment.
 * After all events, the rebuilt buffer is parsed as a single JSON document.
 *
 * Throws when the payload contains no parseable JSONL events at all, or when
 * the rebuilt search buffer is unparseable and no quickSearch results exist —
 * both mean the response shape changed (undocumented endpoint).
 */
export function parseJsonl(payload: string): { quick: AppleSearchMetadata[]; search: AppleSearchStreamItem[] } {
  const quick: AppleSearchMetadata[] = [];
  let searchBuf = '';
  let validEvents = 0;

  for (const rawLine of payload.split('\n')) {
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
      quick.push(...extractQuickResults(event));
    } else if ('diff' in event) {
      searchBuf = applySearchDiff(searchBuf, event.diff);
    }
  }

  if (validEvents === 0) {
    throw new Error('Failed to parse Apple search response: payload contained no valid JSONL events. The response format may have changed.');
  }

  let search: AppleSearchStreamItem[] = [];
  if (searchBuf.trim()) {
    try {
      const parsed = JSON.parse(searchBuf) as { results?: AppleSearchStreamItem[] };
      search = parsed.results ?? [];
    } catch {
      // Tolerate a broken search stream only when quickSearch already gave us results.
      if (quick.length === 0) {
        throw new Error('Failed to rebuild search results from the JSONL diff stream: final buffer was not valid JSON. The response format may have changed.');
      }
    }
  }

  return { quick, search };
}

/**
 * Merge quickSearch and search results, deduplicated by permalink.
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
    const link = meta.permalink ?? meta.title ?? randomUUID();
    if (seen.has(link)) {
      return;
    }
    seen.add(link);
    merged.push({
      title: meta.title ?? '',
      description: excerpt ?? meta.description ?? '',
      availability: meta.availability ?? '',
      hierarchy: meta.hierarchy ?? '',
      permalink: meta.permalink ?? '',
    });
  };

  for (const item of search) {
    push(item.value?.metadata ?? {}, item.excerpt);
  }
  for (const meta of quick) {
    push(meta);
  }

  return merged.slice(0, limit);
}

/**
 * Main entry (port of server.py search_apple_docs): request, parse and merge.
 * Returns up to `limit` (clamped to [1, 30]) deduplicated results.
 * Throws on HTTP errors, network errors and JSONL parse failures — callers
 * must convert thrown errors into explicit isError responses.
 */
export async function searchAppleDocsApi(
  query: string,
  limit: number = 10,
  searchScope: string = '',
): Promise<AppleSearchApiResult[]> {
  const payload = await postQuery(query, searchScope);
  const { quick, search } = parseJsonl(payload);
  const clampedLimit = Math.max(1, Math.min(limit, SEARCH_API_MAX_RESULTS));
  return dedupeMerge(quick, search, clampedLimit);
}

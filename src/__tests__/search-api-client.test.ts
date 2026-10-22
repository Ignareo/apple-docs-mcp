/**
 * Apple JSONL Search API Client Tests
 *
 * Covers the search_apple_docs link that previously had zero tests
 * (the reason the upstream HTML-parser breakage went unnoticed for months):
 *
 *   1. removeLast incremental buffer rebuild of the `search` JSONL diff stream
 *      (pure-append and delete-then-append scenarios)
 *   2. permalink dedupe merge — `search` entries (with excerpt) win over
 *      `quickSearch` entries sharing the same permalink
 *   3. error paths — empty query, HTTP 4xx/5xx, network errors and
 *      unparseable payloads must surface as isError with an
 *      "interface may have changed" hint; a silent "No results" is forbidden.
 *   4. protocol-shape guard — a payload of valid JSON lines that match none
 *      of the known event shapes must error out, not silently report
 *      "No results" (regression guard for the recognized-events check).
 *   5. retry behavior — transient failures (5xx/network) are retried with
 *      backoff, deterministic 4xx fail fast, and outcomes are fed back to
 *      the UserAgentPool (markSuccess/markFailure).
 *
 * HTTP is mocked via global.fetch (tests/setup.ts already installs a jest
 * mock there), so no nock/msw dependency is required.
 */

import {
  API_URL,
  dedupeMerge,
  parseJsonl,
  postQuery,
  searchAppleDocsApi,
} from '../tools/search-api-client.js';
import { formatSearchResults, searchAppleDocs, searchAppleDocsTool } from '../tools/search-parser.js';
import { UserAgentPool } from '../utils/user-agent-pool.js';
import type {
  AppleSearchMetadata,
  AppleSearchStreamItem,
} from '../types/search.js';

const mockFetch = global.fetch as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures — modeled on the §3.2/§3.3 event structure of the handoff doc
// and apple-search-mcp/server.py.
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<AppleSearchMetadata> = {}): AppleSearchMetadata {
  return {
    title: 'UIButtonConfiguration',
    description: 'A configuration that specifies the appearance of a button.',
    availability: 'iOS 15.0+',
    hierarchy: 'UIKit > UIButton',
    permalink: '/uikit/uibuttonconfiguration',
    kind: 'symbol',
    ...overrides,
  };
}

function makeSearchItem(
  excerpt: string,
  metadataOverrides: Partial<AppleSearchMetadata> = {},
): AppleSearchStreamItem {
  return {
    excerpt,
    value: { metadata: makeMetadata(metadataOverrides) },
  };
}

/** Serialize events as a JSONL payload (one JSON object per line). */
function jsonl(...events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** quickSearch results arrive as one full event. */
function quickSearchEvent(...items: Array<{ metadata?: AppleSearchMetadata }>) {
  return { kind: 'quickSearch', response: { results: items } };
}

const QUICK_SEARCH_FINISHED = { kind: 'quickSearchFinished' };
const SEARCH_FINISHED = { kind: 'searchFinished' };

const SHARED_PERMALINK = '/uikit/uibuttonconfiguration';

/**
 * Pure-append `search` diff stream: every event appends to the buffer and
 * removeLast is omitted or 0. Reconstructs a complete `{"results": [...]}`
 * document.
 */
function pureAppendStream(): string {
  const item = makeSearchItem('excerpt for button configuration');
  return jsonl(
    quickSearchEvent(
      { metadata: makeMetadata() },
      { metadata: makeMetadata({ title: 'UIButton', permalink: '/uikit/uibutton' }) },
    ),
    QUICK_SEARCH_FINISHED,
    { diff: { append: `{"results":[${JSON.stringify(item)}]}` } },
    SEARCH_FINISHED,
  );
}

/**
 * Mixed removeLast stream. The buffer is completed provisionally, then a
 * diff event backs up over its closing `]}` (removeLast: 2) and appends a
 * second item plus a new closing — the exact "delete then append" semantics
 * that breaks naive string concatenation.
 *
 * Buffer after each event:
 *   1. `{"results":[<item1>`            (incomplete)
 *   2. `{"results":[<item1>]}`          (complete, provisional)
 *   3. `{"results":[<item1>,<item2>]}`  (final — item2 only via removeLast)
 */
function removeLastStream(): string {
  const item1 = makeSearchItem('first hit', { title: 'UIWindowScene', permalink: '/uikit/uiwindowscene' });
  const item2 = makeSearchItem('second hit', { title: 'UIWindowScene.windows', permalink: '/uikit/uiwindowscene-windows' });
  return jsonl(
    { diff: { append: `{"results":[${JSON.stringify(item1)}`, removeLast: 0 } },
    { diff: { append: ']}' } },
    { diff: { append: `,${JSON.stringify(item2)}]}`, removeLast: 2 } },
    SEARCH_FINISHED,
  );
}

/**
 * Fine-grained removeLast case: the second diff deletes exactly the last
 * 2 chars of a JSON string value (`e"`) and appends `fg"}` — proving the
 * implementation removes characters, not tokens.
 */
function exactRemovalStream(): string {
  // Buffer after each event:
  //   1. `{"results":[{"value":{"metadata":{"title":"abc"`  (mid-string)
  //   2. ...`"abcde"`                                    (still mid-string)
  //   3. `{"results":[{"value":{"metadata":{"title":"abcfg"}}}]}` (final)
  return jsonl(
    { diff: { append: '{"results":[{"value":{"metadata":{"title":"abc' } },
    { diff: { append: 'de' } },
    { diff: { append: 'fg"}}}]}', removeLast: 2 } },
    SEARCH_FINISHED,
  );
}

/**
 * Stream with overlapping permalinks between quickSearch and search:
 * the search copy of the shared entry carries an excerpt and must win;
 * `/uikit/uibutton` is quickSearch-only and must still appear.
 */
function dedupeStream(): string {
  const shared = makeSearchItem('excerpt wins over quickSearch description');
  return jsonl(
    quickSearchEvent(
      { metadata: makeMetadata() },
      { metadata: makeMetadata({ title: 'UIButton', permalink: '/uikit/uibutton', description: 'A button control the user can tap.' }) },
    ),
    QUICK_SEARCH_FINISHED,
    { diff: { append: `{"results":[${JSON.stringify(shared)}]}` } },
    SEARCH_FINISHED,
  );
}

/** Minimal ok:true fetch Response carrying a JSONL text body. */
function jsonlResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Internal Server Error',
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  // Keep retry backoff negligible in unit tests (postQuery reads these per call).
  process.env.SEARCH_API_RETRY_DELAY_MS = '1';
});

afterEach(() => {
  delete process.env.SEARCH_API_RETRY_DELAY_MS;
  delete process.env.SEARCH_API_MAX_RETRIES;
});

// ---------------------------------------------------------------------------
// 1. removeLast incremental rebuild
// ---------------------------------------------------------------------------

describe('parseJsonl: removeLast incremental rebuild', () => {
  it('rebuilds a complete results document from a pure-append diff stream', () => {
    const { quick, search } = parseJsonl(pureAppendStream());

    expect(quick).toHaveLength(2);
    expect(quick.map((m) => m.title)).toEqual(['UIButtonConfiguration', 'UIButton']);

    expect(search).toHaveLength(1);
    expect(search[0].excerpt).toBe('excerpt for button configuration');
    expect(search[0].value?.metadata?.title).toBe('UIButtonConfiguration');
  });

  it('applies removeLast > 0 by deleting buffer tail chars before appending', () => {
    const { search } = parseJsonl(removeLastStream());

    // Item 2 exists only because the provisional closing `]}` from the
    // second diff was removed before the third diff appended the real tail.
    expect(search).toHaveLength(2);
    expect(search.map((i) => i.value?.metadata?.title)).toEqual([
      'UIWindowScene',
      'UIWindowScene.windows',
    ]);
    expect(search.map((i) => i.excerpt)).toEqual(['first hit', 'second hit']);
  });

  it('removes exactly removeLast characters, not JSON tokens', () => {
    const { quick, search } = parseJsonl(exactRemovalStream());

    expect(quick).toHaveLength(0);
    expect(search).toHaveLength(1);
    // 'abcde' with the trailing 'e"' removed, then 'fg"}}]}' appended:
    // final buffer is {"results":[{"value":{"metadata":{"title":"abcfg"}}}]}
    expect(search[0].value?.metadata?.title).toBe('abcfg');
  });

  it('skips blank lines and unparseable JSONL lines without aborting', () => {
    const { quick, search } = parseJsonl(
      `\n${JSON.stringify(quickSearchEvent({ metadata: makeMetadata() }))}\nnot json at all\n\n${JSON.stringify(SEARCH_FINISHED)}\n`,
    );

    expect(quick).toHaveLength(1);
    expect(search).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. permalink dedupe merge
// ---------------------------------------------------------------------------

describe('dedupeMerge: permalink dedupe with excerpt priority', () => {
  it('prefers the search entry (with excerpt) over the quickSearch entry for the same permalink', () => {
    const quick: AppleSearchMetadata[] = [
      makeMetadata(),
      makeMetadata({ title: 'UIButton', permalink: '/uikit/uibutton' }),
    ];
    const search: AppleSearchStreamItem[] = [
      makeSearchItem('excerpt wins over quickSearch description'),
    ];

    const merged = dedupeMerge(quick, search, 10);

    expect(merged).toHaveLength(2);
    // search entries are pushed first
    expect(merged[0].permalink).toBe(SHARED_PERMALINK);
    expect(merged[0].description).toBe('excerpt wins over quickSearch description');
    // quickSearch-only entry survives
    expect(merged[1].permalink).toBe('/uikit/uibutton');
    expect(merged[1].description).toBe('A configuration that specifies the appearance of a button.');
  });

  it('respects the limit after merging', () => {
    const quick: AppleSearchMetadata[] = [makeMetadata({ title: 'UIButton', permalink: '/uikit/uibutton' })];
    const search: AppleSearchStreamItem[] = [makeSearchItem('hit')];

    expect(dedupeMerge(quick, search, 1)).toHaveLength(1);
    expect(dedupeMerge(quick, search, 1)[0].permalink).toBe(SHARED_PERMALINK);
  });

  it('end-to-end: searchAppleDocsApi merges a mocked stream and formats deduped markdown', async () => {
    mockFetch.mockResolvedValue(jsonlResponse(dedupeStream()));

    const results = await searchAppleDocsApi('UIButton configuration');
    expect(results).toHaveLength(2);

    const markdown = formatSearchResults(results, 'UIButton configuration');
    expect(markdown).toContain('**Results:** 2');
    expect(markdown).toContain('excerpt wins over quickSearch description');
    expect(markdown).not.toContain('A configuration that specifies the appearance of a button.');
    // shared permalink appears exactly once
    expect(markdown.match(new RegExp(SHARED_PERMALINK.replace(/\//g, '\\/'), 'g'))).toHaveLength(1);

    // request contract: POST to the query endpoint with browser headers
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(API_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Origin).toBe('https://developer.apple.com');
    expect(headers.Referer).toBe('https://developer.apple.com/search/');
    expect(headers.Accept).toBe('application/jsonl');
    expect(JSON.parse(init.body as string)).toMatchObject({ text: 'UIButton configuration' });
  });
});

// ---------------------------------------------------------------------------
// 3. error paths — isError, explicit message, no silent "No results"
// ---------------------------------------------------------------------------

describe('searchAppleDocs: error paths', () => {
  it('returns isError for an empty or blank query without hitting the network', async () => {
    const result = await searchAppleDocs('   ');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns isError mentioning the interface may have changed on HTTP 5xx', async () => {
    mockFetch.mockResolvedValue(jsonlResponse('Server Error', 500));

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/i);
    expect(result.content[0].text).toMatch(/HTTP 500/);
    // forbidden: silently reporting "no results"
    expect(result.content[0].text).not.toContain('No results.');
    // 5xx is transient: all attempts (initial + 3 retries) were used
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('returns isError mentioning the interface may have changed on HTTP 4xx', async () => {
    mockFetch.mockResolvedValue(jsonlResponse('Not Found', 404));

    const result = await searchAppleDocsTool({ query: 'UIButton' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/i);
    expect(result.content[0].text).not.toContain('No results.');
    // deterministic client error: fail fast, no retries
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns isError mentioning the interface may have changed on network failure', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/i);
    expect(result.content[0].text).not.toContain('No results.');
    // network failures are retried until exhaustion
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('returns isError when the payload has no parseable JSONL events (shape change)', async () => {
    mockFetch.mockResolvedValue(jsonlResponse('<html>not jsonl</html>'));

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/i);
    expect(result.content[0].text).toMatch(/no valid JSONL events/);
    expect(result.content[0].text).not.toContain('No results.');
  });

  it('returns isError when every JSONL line is valid JSON but matches no known event shape', async () => {
    // Regression guard: previously validEvents > 0 alone let an unrecognized
    // payload fall through to a silent "No results." — the exact failure
    // mode the "interface may have changed" hard constraint forbids.
    mockFetch.mockResolvedValue(jsonlResponse('{"foo":1}\n{"bar":2}\n'));

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no recognized Apple search events/);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/i);
    expect(result.content[0].text).not.toContain('No results.');
  });

  it('still tolerates unknown shapes when at least one recognized event is present', async () => {
    // A single control marker proves the protocol is intact even if Apple
    // adds new event kinds alongside the known ones.
    mockFetch.mockResolvedValue(jsonlResponse(
      jsonl({ foo: 1 }, SEARCH_FINISHED),
    ));

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('No results.');
  });

  it('a valid empty result set still reports "No results" without isError', async () => {
    mockFetch.mockResolvedValue(jsonlResponse(
      jsonl(QUICK_SEARCH_FINISHED, SEARCH_FINISHED),
    ));

    const result = await searchAppleDocs('something with no hits');

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('No results.');
  });
});

// ---------------------------------------------------------------------------
// 4. retry behavior + User-Agent pool feedback
// ---------------------------------------------------------------------------

describe('postQuery: retries and User-Agent pool feedback', () => {
  it('recovers from a transient 5xx by retrying and returns results', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonlResponse('Server Error', 500))
      .mockResolvedValueOnce(jsonlResponse(pureAppendStream()));

    const result = await searchAppleDocs('UIButton configuration');

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('**Results:** 2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('recovers from a transient network error by retrying', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonlResponse(pureAppendStream()));

    const result = await searchAppleDocs('UIButton configuration');

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('**Results:** 2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 rate-limit response', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonlResponse('Too Many Requests', 429))
      .mockResolvedValueOnce(jsonlResponse(pureAppendStream()));

    const result = await searchAppleDocs('UIButton configuration');

    expect(result.isError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('reports timeouts as an explicit error without retrying', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('feeds outcomes back to the UserAgentPool (markSuccess / markFailure)', async () => {
    const successSpy = jest.spyOn(UserAgentPool.prototype, 'markSuccess');
    const failureSpy = jest.spyOn(UserAgentPool.prototype, 'markFailure');
    try {
      // success path
      mockFetch.mockResolvedValueOnce(jsonlResponse(pureAppendStream()));
      await postQuery('UIKit button');
      expect(successSpy).toHaveBeenCalledTimes(1);
      expect(successSpy.mock.calls[0][0]).toMatch(/Safari|Mozilla/);
      expect(failureSpy).not.toHaveBeenCalled();

      // failure path — 404 is deterministic: exactly one markFailure with status
      successSpy.mockClear();
      failureSpy.mockClear();
      mockFetch.mockResolvedValueOnce(jsonlResponse('Not Found', 404));
      await expect(postQuery('UIKit button')).rejects.toThrow(/HTTP 404/);
      expect(successSpy).not.toHaveBeenCalled();
      expect(failureSpy).toHaveBeenCalledTimes(1);
      expect(failureSpy.mock.calls[0][1]).toBe(404);
    } finally {
      successSpy.mockRestore();
      failureSpy.mockRestore();
    }
  });

  it('respects SEARCH_API_MAX_RETRIES=0 (single attempt, no retry)', async () => {
    process.env.SEARCH_API_MAX_RETRIES = '0';
    mockFetch.mockResolvedValue(jsonlResponse('Server Error', 500));

    await expect(postQuery('UIKit button')).rejects.toThrow(/HTTP 500/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

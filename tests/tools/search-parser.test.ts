import { jest } from '@jest/globals';
import { formatSearchResults, searchAppleDocs } from '../../src/tools/search-parser.js';
import { parseJsonl, dedupeMerge } from '../../src/tools/search-api-client.js';
import type { AppleSearchApiResult } from '../../src/types/search.js';

// ---------------------------------------------------------------------------
// Fixtures — modeled on apple-search-mcp/server.py §3.2/§3.3 event structure
// ---------------------------------------------------------------------------

function makeQuickMetadata(overrides: Record<string, unknown> = {}) {
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

function makeSearchItem(excerpt: string, metadataOverrides: Record<string, unknown> = {}) {
  return {
    excerpt,
    value: { metadata: makeQuickMetadata(metadataOverrides) },
  };
}

/** Serialize events as a JSONL payload (one JSON object per line). */
function jsonl(...events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** quickSearch results arrive as one full event. */
function quickSearchEvent(...items: Array<{ metadata: Record<string, unknown> }>) {
  return { kind: 'quickSearch', response: { results: items } };
}

const QUICK_SEARCH_FINISHED = { kind: 'quickSearchFinished' };
const SEARCH_FINISHED = { kind: 'searchFinished' };

/** Minimal fetch Response carrying a JSONL text body. */
function jsonlResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: () => Promise.resolve(body),
  };
}

function mockFetchJsonl(body: string, status = 200): void {
  (global.fetch as jest.Mock).mockResolvedValue(jsonlResponse(body, status));
}

// ---------------------------------------------------------------------------
// formatSearchResults — markdown output
// ---------------------------------------------------------------------------

describe('formatSearchResults', () => {
  const results: AppleSearchApiResult[] = [
    {
      title: 'UIView',
      description: 'An object that manages the content for a rectangular area on the screen.',
      availability: 'iOS 2.0+',
      hierarchy: 'UIKit',
      permalink: '/uikit/uiview',
    },
    {
      title: 'UIViewController',
      description: 'An object that manages a view hierarchy for your UIKit app.',
      availability: '',
      hierarchy: '',
      permalink: '/uikit/uiviewcontroller',
    },
  ];

  it('should render the header with query and result count', () => {
    const text = formatSearchResults(results, 'uikit view');

    expect(text).toContain('# Apple Documentation Search Results');
    expect(text).toContain('**Query:** "uikit view"');
    expect(text).toContain('**Results:** 2');
  });

  it('should render numbered entries with hierarchy/description/availability/permalink', () => {
    const text = formatSearchResults(results, 'uikit view');

    expect(text).toContain('### 1. UIView');
    expect(text).toContain('### 2. UIViewController');
    expect(text).toContain('- Hierarchy: UIKit');
    expect(text).toContain('An object that manages the content for a rectangular area on the screen.');
    expect(text).toContain('- iOS 2.0+');
    expect(text).toContain('- /uikit/uiview');
  });

  it('should omit optional lines that are empty', () => {
    const text = formatSearchResults(results, 'uikit view');
    const secondEntry = text.split('### 2.')[1];

    expect(secondEntry).not.toContain('Hierarchy:');
    expect(secondEntry).not.toContain('availability');
  });

  it('should render a No results message for an empty result set', () => {
    const text = formatSearchResults([], 'zzz no such api');

    expect(text).toContain('# Apple Documentation Search Results');
    expect(text).toContain('**Query:** "zzz no such api"');
    expect(text).toContain('No results.');
  });
});

// ---------------------------------------------------------------------------
// parseJsonl — quickSearch full events + search diff stream rebuild
// ---------------------------------------------------------------------------

describe('parseJsonl', () => {
  it('should parse quickSearch results from a full event', () => {
    const payload = jsonl(
      quickSearchEvent({ metadata: makeQuickMetadata() }),
      QUICK_SEARCH_FINISHED,
    );

    const { quick, search } = parseJsonl(payload);

    expect(quick).toHaveLength(1);
    expect(quick[0].title).toBe('UIButtonConfiguration');
    expect(quick[0].permalink).toBe('/uikit/uibuttonconfiguration');
    expect(search).toHaveLength(0);
  });

  it('should rebuild a complete document from a pure-append diff stream', () => {
    const item = makeSearchItem('excerpt for button configuration');
    const payload = jsonl(
      { diff: { append: `{"results":[${JSON.stringify(item)}`, removeLast: 0 } },
      { diff: { append: ']}' } },
      SEARCH_FINISHED,
    );

    const { search } = parseJsonl(payload);

    expect(search).toHaveLength(1);
    expect(search[0].excerpt).toBe('excerpt for button configuration');
    expect(search[0].value?.metadata?.title).toBe('UIButtonConfiguration');
  });

  it('should apply removeLast > 0 by deleting buffer tail chars before appending', () => {
    const item1 = makeSearchItem('first hit', { title: 'UIWindowScene', permalink: '/uikit/uiwindowscene' });
    const item2 = makeSearchItem('second hit', { title: 'UIWindowScene.windows', permalink: '/uikit/uiwindowscene-windows' });
    const payload = jsonl(
      { diff: { append: `{"results":[${JSON.stringify(item1)}`, removeLast: 0 } },
      { diff: { append: ']}' } },
      // The provisional closing `]}` must be removed, not kept — a naive
      // string concat would produce invalid JSON here.
      { diff: { append: `,${JSON.stringify(item2)}]}`, removeLast: 2 } },
      SEARCH_FINISHED,
    );

    const { search } = parseJsonl(payload);

    expect(search).toHaveLength(2);
    expect(search.map(s => s.value?.metadata?.title)).toEqual(['UIWindowScene', 'UIWindowScene.windows']);
  });

  it('should skip malformed lines when valid events exist', () => {
    const payload = `not json at all\n${JSON.stringify(quickSearchEvent({ metadata: makeQuickMetadata() }))}\n{{{\n`;

    const { quick } = parseJsonl(payload);

    expect(quick).toHaveLength(1);
  });

  it('should throw when the payload contains no valid JSONL events', () => {
    expect(() => parseJsonl('this is not jsonl\n<html>...</html>\n')).toThrow(/no valid JSONL events/);
  });

  it('should throw when the rebuilt search buffer is unparseable and no quick results exist', () => {
    const payload = jsonl(
      { diff: { append: '{"results":[broken' } },
      SEARCH_FINISHED,
    );

    expect(() => parseJsonl(payload)).toThrow(/diff stream/);
  });

  it('should tolerate a broken search buffer when quickSearch results exist', () => {
    const payload = jsonl(
      quickSearchEvent({ metadata: makeQuickMetadata() }),
      { diff: { append: '{"results":[broken' } },
      SEARCH_FINISHED,
    );

    const { quick, search } = parseJsonl(payload);

    expect(quick).toHaveLength(1);
    expect(search).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dedupeMerge — permalink dedupe, search (excerpt) first
// ---------------------------------------------------------------------------

describe('dedupeMerge', () => {
  it('should prefer the search entry (with excerpt) over quickSearch for the same permalink', () => {
    const quick = [makeQuickMetadata()];
    const search = [makeSearchItem('excerpt wins over quickSearch description')];

    const merged = dedupeMerge(quick, search, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('excerpt wins over quickSearch description');
  });

  it('should keep quickSearch-only entries and order search entries first', () => {
    const quick = [
      makeQuickMetadata(),
      makeQuickMetadata({ title: 'UIButton', permalink: '/uikit/uibutton' }),
    ];
    const search = [makeSearchItem('hit', { title: 'UIWindowScene', permalink: '/uikit/uiwindowscene' })];

    const merged = dedupeMerge(quick, search, 10);

    expect(merged.map(r => r.title)).toEqual(['UIWindowScene', 'UIButtonConfiguration', 'UIButton']);
  });

  it('should respect the limit', () => {
    const quick = Array.from({ length: 5 }, (_, i) =>
      makeQuickMetadata({ title: `Result ${i}`, permalink: `/documentation/result${i}` }),
    );

    const merged = dedupeMerge(quick, [], 3);

    expect(merged).toHaveLength(3);
    expect(merged.map(r => r.title)).toEqual(['Result 0', 'Result 1', 'Result 2']);
  });
});

// ---------------------------------------------------------------------------
// searchAppleDocs — tool entry with mocked global.fetch
// ---------------------------------------------------------------------------

describe('searchAppleDocs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return formatted markdown for a full JSONL payload', async () => {
    mockFetchJsonl(jsonl(
      quickSearchEvent(
        { metadata: makeQuickMetadata() },
        { metadata: makeQuickMetadata({ title: 'UIButton', permalink: '/uikit/uibutton', description: 'A UIKit button.' }) },
      ),
      QUICK_SEARCH_FINISHED,
      { diff: { append: `{"results":[${JSON.stringify(makeSearchItem('excerpt for button configuration'))}]}` } },
      SEARCH_FINISHED,
    ));

    const result = await searchAppleDocs('UIButton configuration');

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('# Apple Documentation Search Results');
    expect(text).toContain('**Query:** "UIButton configuration"');
    // search entry (with excerpt) wins over the quickSearch duplicate
    expect(text).toContain('excerpt for button configuration');
    const firstEntry = text.split('### 2.')[0];
    expect(firstEntry).not.toContain('A configuration that specifies the appearance of a button.');
    expect(text).toContain('### 2. UIButton');
    expect(text).toContain('A UIKit button.');
  });

  it('should return isError for an empty query without calling the backend', async () => {
    const result = await searchAppleDocs('   ');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query must be a non-empty string');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should return isError mentioning interface change on HTTP 4xx/5xx', async () => {
    mockFetchJsonl('Server Error', 500);

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/HTTP 500/);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/);
  });

  it('should return isError mentioning interface change on network failure', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('fetch failed'));

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/);
  });

  it('should return isError instead of a silent No results on unparseable payloads', async () => {
    mockFetchJsonl('<html><body>app shell, no JSONL</body></html>');

    const result = await searchAppleDocs('UIButton');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/undocumented Apple interface and may have changed/);
    expect(result.content[0].text).not.toMatch(/^# Apple Documentation Search Results[\s\S]*No results\.$/);
  });
});

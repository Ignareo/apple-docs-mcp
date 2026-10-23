import { jest } from '@jest/globals';

jest.mock('../../src/utils/cache.js');
jest.mock('../../src/utils/http-client.js');

import { indexCache } from '../../src/utils/cache.js';
import { httpClient } from '../../src/utils/http-client.js';
import {
  getPreloadStats,
  preloadFrameworksByUsage,
  preloadPopularFrameworks,
} from '../../src/utils/preloader.js';
import {
  getFrameworkIndexCacheKey,
  getFrameworkIndexUrl,
} from '../../src/tools/search-framework-symbols.js';

/** Create a stateful in-memory cache for the mocked indexCache. */
function useStatefulCache(): Map<string, unknown> {
  const store = new Map<string, unknown>();

  (indexCache.get as jest.Mock).mockImplementation((key: string) => store.get(key));
  (indexCache.has as jest.Mock).mockImplementation((key: string) => store.has(key));
  (indexCache.set as jest.Mock).mockImplementation((key: string, value: unknown) => {
    store.set(key, value);
  });
  (indexCache.getStats as jest.Mock).mockImplementation(() => ({
    size: store.size,
    maxSize: 100,
    hitRate: '0.00%',
    hits: 0,
    misses: 0,
  }));

  return store;
}

describe('preloader', () => {
  let store: Map<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.APPLE_DOCS_PRELOAD_ENABLED;
    delete process.env.APPLE_DOCS_PRELOAD_CONCURRENCY;
    delete process.env.APPLE_DOCS_PRELOAD_DELAY_MS;

    store = useStatefulCache();
    (httpClient.getJson as jest.Mock).mockResolvedValue({
      interfaceLanguages: { swift: [] },
    });
  });

  it('preloads using the same raw-index cache key as searchFrameworkSymbols', async () => {
    await preloadPopularFrameworks();

    const uikitUrl = getFrameworkIndexUrl('uikit');
    expect(httpClient.getJson).toHaveBeenCalledWith(
      uikitUrl,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );

    // The key shared with the live tool must be populated...
    expect(store.has(getFrameworkIndexCacheKey(uikitUrl))).toBe(true);
    // ...and the old key that nothing ever read must not be.
    expect(store.has('framework-index-uikit')).toBe(false);

    const stats = getPreloadStats();
    expect(stats.preloadedFrameworks).toContain('uikit');
    expect(stats.preloadedFrameworks.length).toBeGreaterThan(0);
    expect(stats.totalCached).toBeGreaterThan(0);
  });

  it('skips frameworks whose raw index is already cached', async () => {
    await preloadPopularFrameworks();
    const callsAfterFirstRun = (httpClient.getJson as jest.Mock).mock.calls.length;
    expect(callsAfterFirstRun).toBeGreaterThan(0);

    await preloadPopularFrameworks();

    expect((httpClient.getJson as jest.Mock).mock.calls.length).toBe(callsAfterFirstRun);
  });

  it('can be disabled with APPLE_DOCS_PRELOAD_ENABLED=false', async () => {
    process.env.APPLE_DOCS_PRELOAD_ENABLED = 'false';

    await preloadPopularFrameworks();

    expect(httpClient.getJson).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('limits background concurrency so it does not starve foreground calls', async () => {
    let active = 0;
    let maxActive = 0;

    (httpClient.getJson as jest.Mock).mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { interfaceLanguages: { swift: [] } };
    });

    await preloadPopularFrameworks();

    expect(maxActive).toBeGreaterThan(0);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('never rejects when a preload request fails', async () => {
    (httpClient.getJson as jest.Mock).mockRejectedValue(new Error('network down'));

    await expect(preloadPopularFrameworks()).resolves.toBeUndefined();
  });

  it('preloads user frameworks under the shared raw-index key', async () => {
    await preloadFrameworksByUsage(['AVFoundation']);

    const url = getFrameworkIndexUrl('avfoundation');
    expect(httpClient.getJson).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(store.has(getFrameworkIndexCacheKey(url))).toBe(true);
  });
});

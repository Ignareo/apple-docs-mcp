import { jest } from '@jest/globals';
import {
  searchFrameworkSymbols,
  getFrameworkIndexUrl,
  getFrameworkIndexCacheKey,
} from '../../src/tools/search-framework-symbols.js';
import { mockData, createTestFrameworkIndex } from '../helpers/test-helpers.js';

// Mock dependencies
jest.mock('../../src/utils/cache.js');
jest.mock('../../src/utils/http-client.js');

import { indexCache } from '../../src/utils/cache.js';
import { httpClient } from '../../src/utils/http-client.js';

/** Create a stateful in-memory cache so cache-reuse tests are meaningful. */
function useStatefulCache(): Map<string, unknown> {
  const store = new Map<string, unknown>();

  (indexCache.get as jest.Mock).mockImplementation((key: string) => store.get(key));
  (indexCache.has as jest.Mock).mockImplementation((key: string) => store.has(key));
  (indexCache.set as jest.Mock).mockImplementation((key: string, value: unknown) => {
    store.set(key, value);
  });

  return store;
}

describe('searchFrameworkSymbols', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('successful searches', () => {
    it('should search for classes in UIKit framework', async () => {
      // Mock cache miss
      (indexCache.get as jest.Mock).mockReturnValue(null);

      // Mock HTTP response
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(httpClient.getJson).toHaveBeenCalledWith(
        'https://developer.apple.com/tutorials/data/index/uikit',
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(result).toContain('UIView');
      expect(result).toContain('UIViewController');
      expect(result).toContain('Found:** 4 of 4 classes');
      expect(indexCache.set).toHaveBeenCalled();
    });

    it('should search with wildcard pattern', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      const result = await searchFrameworkSymbols('uikit', 'class', '*View', 'swift', 10);

      expect(result).toContain('UIView');
      expect(result).toContain('UITableView');
      expect(result).toContain('UIStackView');
      expect(result).not.toContain('UIViewController');
      expect(result).toContain('matching "*View"');
    });

    it('should search all symbol types', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      const result = await searchFrameworkSymbols('uikit', 'all', undefined, 'swift', 10);

      expect(result).toContain('## Classes (4)');
      expect(result).toContain('## Structs (1)');
      expect(result).toContain('UIView');
      expect(result).toContain('List');
    });

    it('should use cache when available', async () => {
      const cachedResult = '# Cached Result';
      (indexCache.get as jest.Mock).mockReturnValue(cachedResult);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).toBe(cachedResult);
      expect(httpClient.getJson).not.toHaveBeenCalled();
    });

    it('should respect limit parameter', async () => {
      const manyItems = Array.from({ length: 20 }, (_, i) => ({
        path: `/documentation/uikit/class${i}`,
        title: `Class${i}`,
        type: 'class',
        beta: false,
        deprecated: false,
        children: [],
      }));

      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(
        createTestFrameworkIndex(manyItems)
      );

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 5);

      // Count occurrences of class links
      const classLinks = (result.match(/\[.*?\]/g) || []).length;
      expect(classLinks).toBe(5);
      // Total count must reflect the full index, not just the returned slice.
      expect(result).toContain('**Found:** 5 of 20 classes');
    });

    it('should support Objective-C language', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'occ', 10);

      expect(result).toContain('UIView');
      expect(result).toContain('Found:** 1 of 1 classes');
    });
  });

  describe('raw index caching', () => {
    it('should reuse the raw index JSON across different limit/symbolType queries', async () => {
      const store = useStatefulCache();
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      const first = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 5);
      const second = await searchFrameworkSymbols('uikit', 'all', undefined, 'swift', 50);

      expect(first).toContain('**Found:** 4 of 4 classes');
      expect(second).toContain('UIView');

      // The index must be downloaded exactly once...
      expect(httpClient.getJson).toHaveBeenCalledTimes(1);

      // ...and cached under the same key the preloader checks.
      const expectedRawKey = getFrameworkIndexCacheKey(
        getFrameworkIndexUrl('uikit'),
      );
      expect(store.has(expectedRawKey)).toBe(true);
      // The old, never-matching preload key must not be used.
      expect(store.has('framework-index-uikit')).toBe(false);
    });

    it('should deduplicate concurrent raw index downloads', async () => {
      useStatefulCache();
      let resolveFetch: (value: typeof mockData.frameworkIndex) => void = () => {};
      (httpClient.getJson as jest.Mock).mockImplementation(
        () => new Promise(resolve => { resolveFetch = resolve; }),
      );

      const first = searchFrameworkSymbols('uikit', 'all', undefined, 'swift', 10);
      const second = searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 5);

      expect(httpClient.getJson).toHaveBeenCalledTimes(1);

      resolveFetch(mockData.frameworkIndex);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toContain('UIView');
      expect(secondResult).toContain('UIView');
      expect(httpClient.getJson).toHaveBeenCalledTimes(1);
    });
  });

  describe('linking and filtering', () => {
    it('should never render an undefined link for path-less group markers', async () => {
      const index = createTestFrameworkIndex([
        {
          title: 'Views',
          type: 'groupMarker',
          children: [
            {
              path: '/documentation/uikit/uiview',
              title: 'UIView',
              type: 'class',
              children: [],
            },
          ],
        },
      ]);

      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(index);

      const result = await searchFrameworkSymbols('uikit', 'all', undefined, 'swift', 10);

      expect(result).not.toContain('undefined');
      expect(result).not.toContain('[**Views**]');
      expect(result).toContain('[**UIView**](https://developer.apple.com/documentation/uikit/uiview)');
      expect(result).toContain('**Found:** 1 of 1 symbols');
    });

    it('should render a plain title when a listable item has no path', async () => {
      const index = createTestFrameworkIndex([
        { title: 'MysterySymbol', type: 'class', path: undefined, children: [] },
      ]);

      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(index);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).toContain('- **MysterySymbol**');
      expect(result).not.toContain('undefined');
    });

    it('should skip items without a title', async () => {
      const index = createTestFrameworkIndex([
        { path: '/documentation/uikit/untitled', title: '   ', type: 'class', children: [] },
        {
          path: '/documentation/uikit/uiview',
          title: 'UIView',
          type: 'class',
          children: [],
        },
      ]);

      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(index);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).not.toContain('/documentation/uikit/untitled');
      expect(result).toContain('**Found:** 1 of 1 classes');
    });
  });

  describe('error cases', () => {
    it('should handle invalid framework gracefully', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockRejectedValue(new Error('404 Not Found'));

      const result = await searchFrameworkSymbols('invalidframework', 'class', undefined, 'swift', 10);

      expect(result).toContain('Error: search_framework_symbols failed: 404 Not Found');
      expect(result).toContain('framework "invalidframework" not found');
      expect(result).toContain('list_technologies');
    });

    it('should handle empty framework name', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockRejectedValue(new Error('Invalid URL'));

      const result = await searchFrameworkSymbols('', 'class', undefined, 'swift', 10);

      expect(result).toContain('Error: search_framework_symbols failed');
    });

    it('should suggest a retry when the index request times out', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockRejectedValue(
        new Error('Request timed out. Please try again later.'),
      );

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).toContain('Error: search_framework_symbols failed');
      expect(result).toContain('framework index is large');
      expect(result).toContain('retry');
    });

    it('should handle unsupported language', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue({
        interfaceLanguages: {
          swift: mockData.frameworkIndex.interfaceLanguages.swift,
        },
      });

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'java', 10);

      expect(result).toContain('Language "java" not available');
      expect(result).toContain('Available languages: swift');
    });

    it('should handle no results gracefully', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue({
        interfaceLanguages: {
          swift: [
            {
              path: '/documentation/uikit/uiview',
              title: 'UIView',
              type: 'class',  // Not a macro
              beta: false,
              deprecated: false,
              children: [],
            }
          ]
        }
      });

      const result = await searchFrameworkSymbols('uikit', 'macro', undefined, 'swift', 10);

      expect(result).toContain('No macros found in uikit framework');
    });

    it('should handle network errors', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).toContain('Error: search_framework_symbols failed: Network error');
    });
  });

  describe('edge cases', () => {
    it('should handle special characters in pattern', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      const result = await searchFrameworkSymbols('uikit', 'class', 'UI[View]*', 'swift', 10);

      // Special characters should be escaped, so no matches
      expect(result).toContain('No classes found matching pattern "UI[View]*"');
    });

    it('should handle deeply nested items', async () => {
      const nestedIndex = createTestFrameworkIndex([
        {
          path: '/documentation/uikit/views',
          title: 'Views',
          type: 'collection',
          children: [
            {
              path: '/documentation/uikit/views/basic',
              title: 'Basic Views',
              type: 'collection',
              children: [
                {
                  path: '/documentation/uikit/uiview',
                  title: 'UIView',
                  type: 'class',
                  children: [],
                },
              ],
            },
          ],
        },
      ]);

      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(nestedIndex);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).toContain('UIView');
      expect(result).toContain('Found:** 1 of 1 classes');
    });

    it('should handle framework name case variations', async () => {
      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(mockData.frameworkIndex);

      // Test different case variations
      const result1 = await searchFrameworkSymbols('UIKit', 'class', undefined, 'swift', 1);
      const result2 = await searchFrameworkSymbols('UIKIT', 'class', undefined, 'swift', 1);
      const result3 = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 1);

      // All should call the same lowercase URL
      expect(httpClient.getJson).toHaveBeenCalledWith(
        'https://developer.apple.com/tutorials/data/index/uikit',
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(httpClient.getJson).toHaveBeenCalledTimes(3);
      expect(result1).toContain('**Found:** 1 of 4 classes');
      expect(result2).toContain('**Found:** 1 of 4 classes');
      expect(result3).toContain('**Found:** 1 of 4 classes');
    });

    it('should handle items with beta and deprecated flags', async () => {
      const flaggedIndex = createTestFrameworkIndex([
        {
          path: '/documentation/uikit/betaclass',
          title: 'BetaClass',
          type: 'class',
          beta: true,
          deprecated: false,
          children: [],
        },
        {
          path: '/documentation/uikit/deprecatedclass',
          title: 'DeprecatedClass',
          type: 'class',
          beta: false,
          deprecated: true,
          children: [],
        },
      ]);

      (indexCache.get as jest.Mock).mockReturnValue(null);
      (httpClient.getJson as jest.Mock).mockResolvedValue(flaggedIndex);

      const result = await searchFrameworkSymbols('uikit', 'class', undefined, 'swift', 10);

      expect(result).toContain('BetaClass**');
      expect(result).toContain('*(Beta, Class)*');
      expect(result).toContain('DeprecatedClass**');
      expect(result).toContain('*(Deprecated, Class)*');
    });
  });
});

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { handleGetDocumentationUpdates } from '../../src/tools/get-documentation-updates.js';
import { httpClient } from '../../src/utils/http-client.js';
import { updatesCache } from '../../src/utils/cache.js';

// Mock dependencies
jest.mock('../../src/utils/http-client.js');
jest.mock('../../src/utils/cache.js', () => ({
  updatesCache: {
    get: jest.fn(),
    set: jest.fn(),
  },
  generateUrlCacheKey: jest.fn((key, params) => `${key}-${JSON.stringify(params)}`),
}));

describe('get-documentation-updates', () => {
  const mockUpdatesData = {
    topicSections: [
      {
        title: 'WWDC',
        identifiers: [
          'doc://com.apple.Updates/documentation/Updates/wwdc2024',
          'doc://com.apple.Updates/documentation/Updates/wwdc2023',
        ],
        anchor: 'WWDC',
      },
      {
        title: 'Technology updates',
        identifiers: [
          'doc://com.apple.Updates/documentation/Updates/SwiftUI',
          'doc://com.apple.Updates/documentation/Updates/UIKit',
        ],
        anchor: 'Technology-updates',
      },
      {
        title: 'Release notes for SDKs, Xcode, and Safari',
        identifiers: [
          'doc://com.apple.documentation/documentation/ios-ipados-release-notes',
        ],
        anchor: 'Release-notes-for-SDKs-Xcode-and-Safari',
      },
    ],
    references: {
      'doc://com.apple.Updates/documentation/Updates/wwdc2024': {
        type: 'topic',
        title: 'WWDC24',
        url: '/documentation/updates/wwdc2024',
        abstract: [{ text: 'Highlights of new technologies introduced at WWDC24.', type: 'text' }],
        images: [{ type: 'icon', identifier: 'new.svg' }],
        kind: 'article',
        role: 'collectionGroup',
      },
      'doc://com.apple.Updates/documentation/Updates/wwdc2023': {
        type: 'topic',
        title: 'WWDC23',
        url: '/documentation/updates/wwdc2023',
        abstract: [{ text: 'Highlights of new technologies introduced at WWDC23.', type: 'text' }],
        kind: 'article',
        role: 'collectionGroup',
      },
      'doc://com.apple.Updates/documentation/Updates/SwiftUI': {
        type: 'topic',
        title: 'SwiftUI updates',
        url: '/documentation/updates/swiftui',
        abstract: [{ text: 'Learn about important changes to SwiftUI.', type: 'text' }],
        kind: 'article',
        role: 'article',
      },
      'doc://com.apple.Updates/documentation/Updates/UIKit': {
        type: 'topic',
        title: 'UIKit updates',
        url: '/documentation/updates/uikit',
        abstract: [{ text: 'Learn about important changes to UIKit.', type: 'text' }],
        kind: 'article',
        role: 'article',
      },
      'doc://com.apple.documentation/documentation/ios-ipados-release-notes': {
        type: 'topic',
        title: 'iOS & iPadOS Release Notes',
        url: '/documentation/ios-ipados-release-notes',
        abstract: [{ text: 'Learn about changes to the iOS & iPadOS SDK.', type: 'text' }],
        kind: 'article',
        role: 'collection',
      },
    },
  };

  const mockUpdatesIndex = {
    interfaceLanguages: {
      swift: [
        {
          path: '/documentation/updates',
          title: 'Updates',
          type: 'module',
          children: [
            {
              title: 'WWDC',
              type: 'groupMarker',
            },
            {
              path: '/documentation/updates/wwdc2024',
              title: 'WWDC24',
              type: 'collection',
              beta: false,
            },
            {
              path: '/documentation/updates/wwdc2023',
              title: 'WWDC23',
              type: 'collection',
              beta: false,
            },
            {
              title: 'Technology updates',
              type: 'groupMarker',
            },
            {
              path: '/documentation/updates/swiftui',
              title: 'SwiftUI updates',
              type: 'article',
              beta: true,
            },
            {
              path: '/documentation/updates/uikit',
              title: 'UIKit updates',
              type: 'article',
              beta: false,
            },
          ],
        },
      ],
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (updatesCache.get as jest.Mock).mockReturnValue(null);
    (httpClient.getJson as jest.Mock).mockImplementation((url: unknown) => {
      const urlStr = url as string;
      if (urlStr.includes('Updates.json')) {
        return Promise.resolve(mockUpdatesData);
      }
      if (urlStr.includes('index/updates')) {
        return Promise.resolve(mockUpdatesIndex);
      }
      throw new Error('Unknown URL');
    });
  });

  it('should fetch and format documentation updates', async () => {
    const result = await handleGetDocumentationUpdates();

    expect(httpClient.getJson).toHaveBeenCalledTimes(2);
    expect(result).toContain('Apple Developer Documentation Updates');
    expect(result).toContain('WWDC24');
    expect(result).toContain('SwiftUI updates');
    expect(result).toContain('UIKit updates');
  });

  it('should filter by category', async () => {
    const result = await handleGetDocumentationUpdates('wwdc');

    expect(result).toContain('WWDC24');
    expect(result).toContain('WWDC23');
    expect(result).not.toContain('SwiftUI updates');
    expect(result).not.toContain('UIKit updates');
  });

  it('should filter by technology', async () => {
    // `auto` treats technology as a timeline request; this test pins the
    // legacy index behavior, so select it explicitly.
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 50, 'index',
    );

    expect(result).toContain('SwiftUI updates');
    expect(result).not.toContain('UIKit updates');
    expect(result).not.toContain('WWDC24');
  });

  it('should filter by year for WWDC', async () => {
    const result = await handleGetDocumentationUpdates('wwdc', undefined, '2024');

    expect(result).toContain('WWDC24');
    expect(result).not.toContain('WWDC23');
  });

  it('should filter release notes', async () => {
    const result = await handleGetDocumentationUpdates('release-notes');

    expect(result).toContain('iOS & iPadOS Release Notes');
    expect(result).not.toContain('WWDC');
    expect(result).not.toContain('SwiftUI updates');
  });

  it('should exclude beta features when includeBeta is false', async () => {
    const result = await handleGetDocumentationUpdates('technology', undefined, undefined, undefined, false);

    expect(result).toContain('UIKit updates'); // Not beta
    expect(result).not.toContain('SwiftUI updates'); // This is marked as beta
  });

  it('should include beta features when includeBeta is true', async () => {
    const result = await handleGetDocumentationUpdates('technology', undefined, undefined, undefined, true);

    expect(result).toContain('UIKit updates');
    expect(result).toContain('SwiftUI updates');
    expect(result).toContain('*Beta*'); // Beta badge should be shown
  });

  it('should search by query', async () => {
    const result = await handleGetDocumentationUpdates('all', undefined, undefined, 'SwiftUI');

    expect(result).toContain('SwiftUI updates');
    expect(result).not.toContain('UIKit updates');
    expect(result).not.toContain('WWDC24');
  });

  it('should limit results', async () => {
    const result = await handleGetDocumentationUpdates('all', undefined, undefined, undefined, true, 2);

    // Should contain only two results
    const updateCount = (result.match(/###/g) || []).length;
    expect(updateCount).toBe(2);
  });

  it('should show new badges', async () => {
    const result = await handleGetDocumentationUpdates('wwdc');

    expect(result).toContain('WWDC24');
    expect(result).toContain('*New*'); // WWDC24 has new.svg image
  });

  it('should use cache when available', async () => {
    const cachedResult = '# Cached Updates\n\nThis is cached content.';
    (updatesCache.get as jest.Mock).mockReturnValue(cachedResult);

    const result = await handleGetDocumentationUpdates();

    expect(httpClient.getJson).not.toHaveBeenCalled();
    expect(result).toBe(cachedResult);
  });

  it('should store results in cache', async () => {
    await handleGetDocumentationUpdates('all', undefined, undefined, undefined, true, 10);

    expect(updatesCache.set).toHaveBeenCalled();
    const [cacheKey, cachedValue] = (updatesCache.set as jest.Mock).mock.calls[0];
    expect(cacheKey).toContain('documentation-updates');
    expect(cachedValue).toContain('Apple Developer Documentation Updates');
  });

  it('should handle empty results', async () => {
    // Mock empty data
    (httpClient.getJson as jest.Mock).mockImplementation((url: unknown) => {
      const urlStr = url as string;
      if (urlStr.includes('Updates.json')) {
        return Promise.resolve({ topicSections: [], references: {} });
      }
      if (urlStr.includes('index/updates')) {
        return Promise.resolve({ interfaceLanguages: { swift: [] } });
      }
      throw new Error('Unknown URL');
    });

    const result = await handleGetDocumentationUpdates();

    expect(result).toBe('No documentation updates found matching the specified criteria.');
  });

  it('should handle errors gracefully', async () => {
    (httpClient.getJson as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await handleGetDocumentationUpdates();

    expect(result).toContain('Error: Failed to fetch documentation updates');
    expect(result).toContain('Network error');
  });

  it('should handle partial data correctly', async () => {
    // Mock data with missing references
    (httpClient.getJson as jest.Mock).mockImplementation((url: unknown) => {
      const urlStr = url as string;
      if (urlStr.includes('Updates.json')) {
        return Promise.resolve({
          topicSections: [
            {
              title: 'WWDC',
              identifiers: ['doc://com.apple.Updates/documentation/Updates/wwdc2024'],
              anchor: 'WWDC',
            },
          ],
          references: {}, // Empty references
        });
      }
      if (urlStr.includes('index/updates')) {
        return Promise.resolve(mockUpdatesIndex);
      }
      throw new Error('Unknown URL');
    });

    const result = await handleGetDocumentationUpdates();

    // Should handle gracefully and return no results
    expect(result).toBe('No documentation updates found matching the specified criteria.');
  });

  it('should extract technology from path correctly', async () => {
    const result = await handleGetDocumentationUpdates('technology');

    // SwiftUI should have technology extracted from path
    expect(result).toContain('SwiftUI updates');
    // Since we're in technology category, the technology metadata is not shown (it's redundant)
    // The technology extraction is working internally as the beta flag is correctly applied
    expect(result).toContain('*Beta*'); // Beta status correctly extracted from index
  });

  it('should group updates by category', async () => {
    const result = await handleGetDocumentationUpdates();

    // Check proper grouping
    const wwdcIndex = result.indexOf('## WWDC');
    const techIndex = result.indexOf('## Technology Updates');
    const releaseIndex = result.indexOf('## Release Notes');

    expect(wwdcIndex).toBeGreaterThan(-1);
    expect(techIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(-1);

    // WWDC should come before Technology Updates
    expect(wwdcIndex).toBeLessThan(techIndex);
    // Technology Updates should come before Release Notes
    expect(techIndex).toBeLessThan(releaseIndex);
  });
});

describe('get-documentation-updates — Past releases classification', () => {
  it('classifies WWDC articles nested under "Past releases" as wwdc', async () => {
    (httpClient.getJson as jest.Mock).mockImplementation((url: unknown) => {
      const urlStr = url as string;
      if (urlStr.includes('Updates.json')) {
        return Promise.resolve({
          topicSections: [
            {
              title: 'Past releases',
              identifiers: [
                'doc://com.apple.Updates/documentation/Updates/wwdc2024',
                'doc://com.apple.Updates/documentation/Updates/SwiftUI',
              ],
              anchor: 'Past-releases',
            },
          ],
          references: {
            'doc://com.apple.Updates/documentation/Updates/wwdc2024': {
              type: 'topic', title: 'WWDC24', url: '/documentation/updates/wwdc2024',
              abstract: [{ text: 'Highlights of WWDC24.', type: 'text' }],
              kind: 'article', role: 'collectionGroup',
            },
            'doc://com.apple.Updates/documentation/Updates/SwiftUI': {
              type: 'topic', title: 'SwiftUI updates', url: '/documentation/updates/swiftui',
              abstract: [{ text: 'Changes to SwiftUI.', type: 'text' }],
              kind: 'article', role: 'article',
            },
          },
        });
      }
      if (urlStr.includes('index/updates')) {
        return Promise.resolve({ interfaceLanguages: { swift: [
          { path: '/documentation/updates/wwdc2024', title: 'WWDC24', type: 'collection', beta: false },
        ] } });
      }
      throw new Error('Unknown URL');
    });

    const result = await handleGetDocumentationUpdates('wwdc', undefined, '2024');

    expect(result).toContain('WWDC24');
    expect(result).not.toContain('SwiftUI updates');
    expect(result).toContain('2024');
  });
});

// ---------------------------------------------------------------------------
// Timeline mode (detail="timeline" / auto with technology)
// ---------------------------------------------------------------------------

describe('get-documentation-updates — dated timeline', () => {
  const timelineIndex = {
    interfaceLanguages: {
      swift: [
        {
          path: '/documentation/updates',
          title: 'Updates',
          type: 'module',
          children: [
            { title: 'Technology and frameworks', type: 'groupMarker' },
            { path: '/documentation/updates/swiftui', title: 'SwiftUI updates', type: 'article' },
            { path: '/documentation/updates/uikit', title: 'UIKit updates', type: 'article' },
            { path: '/documentation/updates/app-intents', title: 'App Intents updates', type: 'article' },
          ],
        },
      ],
    },
    references: {
      'doc://com.apple.Updates/documentation/updates/swiftui': {
        title: 'SwiftUI updates',
        url: '/documentation/updates/swiftui',
      },
    },
  };

  function paragraph(text: string, identifiers: string[] = []) {
    return {
      type: 'paragraph',
      inlineContent: [
        { type: 'text', text },
        ...identifiers.flatMap(identifier => [
          { type: 'reference', identifier, isActive: true },
          { type: 'text', text: '.' },
        ]),
      ],
    };
  }

  const timelineReferences = {
    'doc://com.apple.SwiftUI/documentation/SwiftUI': {
      title: 'SwiftUI', url: '/documentation/swiftui',
    },
    'doc://com.apple.SwiftUI/documentation/SwiftUI/ArrangementView': {
      title: 'ArrangementView', url: '/documentation/swiftui/arrangementview',
    },
    'doc://com.apple.SwiftUI/documentation/SwiftUI/ReservedRegion': {
      title: 'ReservedRegion', url: '/documentation/swiftui/reservedregion',
    },
  };

  const timelineDocument = {
    metadata: { title: 'SwiftUI updates' },
    abstract: [{ type: 'text', text: 'Learn about important changes to SwiftUI.' }],
    primaryContentSections: [
      {
        kind: 'content',
        content: [
          { type: 'heading', level: 2, text: 'Overview' },
          { type: 'paragraph', inlineContent: [{ type: 'text', text: 'Browse notable changes in SwiftUI.' }] },
          { type: 'heading', level: 2, text: 'September 2026' },
          { type: 'heading', level: 3, text: 'Arrangement views' },
          {
            type: 'unorderedList',
            items: [
              { content: [paragraph('Arrange content with ', ['doc://com.apple.SwiftUI/documentation/SwiftUI/ArrangementView'])] },
              { content: [{ type: 'paragraph', inlineContent: [
                { type: 'text', text: 'Configure the style with ' },
                { type: 'codeVoice', code: 'arrangementViewStyle' },
                { type: 'text', text: '.' },
              ] }] },
            ],
          },
          { type: 'heading', level: 3, text: 'Reserved regions' },
          {
            type: 'unorderedList',
            items: [{ content: [paragraph('Avoid reserved regions with ', ['doc://com.apple.SwiftUI/documentation/SwiftUI/ReservedRegion'])] }],
          },
          { type: 'heading', level: 2, text: 'June 2025' },
          { type: 'heading', level: 3, text: 'Text' },
          {
            type: 'unorderedList',
            items: [{ content: [paragraph('New text features for widgets.')] }],
          },
          { type: 'heading', level: 2, text: 'June 2023, visionOS' },
          {
            type: 'paragraph',
            inlineContent: [{ type: 'text', text: 'Scenes work in immersive spaces.' }],
          },
        ],
      },
    ],
    references: timelineReferences,
  };

  /** URL-aware getJson mock covering index, legacy Updates.json and the timeline doc. */
  function mockTimeline(doc: unknown = timelineDocument, index: unknown = timelineIndex) {
    (httpClient.getJson as jest.Mock).mockImplementation((url: unknown) => {
      const urlStr = url as string;
      if (urlStr.includes('documentation/updates/swiftui.json')) {
        return Promise.resolve(doc);
      }
      if (urlStr.includes('index/updates')) {
        return Promise.resolve(index);
      }
      if (urlStr.includes('Updates.json')) {
        return Promise.resolve(legacyUpdatesData);
      }
      throw new Error(`Unknown URL: ${urlStr}`);
    });
  }

  const legacyUpdatesData = {
    topicSections: [
      {
        title: 'Technology updates',
        identifiers: ['doc://com.apple.Updates/documentation/Updates/SwiftUI'],
        anchor: 'Technology-updates',
      },
    ],
    references: {
      'doc://com.apple.Updates/documentation/Updates/SwiftUI': {
        type: 'topic', title: 'SwiftUI updates', url: '/documentation/updates/swiftui',
        abstract: [{ text: 'Learn about important changes to SwiftUI.', type: 'text' }],
        kind: 'article', role: 'article',
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (updatesCache.get as jest.Mock).mockReturnValue(null);
    mockTimeline();
  });

  it('renders dated sections with markdown links and a change count', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 50, 'timeline',
    );

    expect(result).toContain('# SwiftUI Documentation Updates');
    expect(result).toContain('Learn about important changes to SwiftUI.');
    expect(result).toContain('Showing 5 of 5 changes · sections: 3');
    expect(result).toContain('## September 2026');
    expect(result).toContain('### Arrangement views');
    expect(result).toContain('- Arrange content with [ArrangementView](https://developer.apple.com/documentation/swiftui/arrangementview).');
    expect(result).toContain('- Configure the style with `arrangementViewStyle`.');
    expect(result).toContain('## June 2025');
    expect(result).toContain('## June 2023, visionOS');
    expect(result).toContain('- Scenes work in immersive spaces.');
    // The Overview preamble must not leak in as an entry.
    expect(result).not.toContain('- Browse notable changes');
  });

  it('auto routes to the timeline when a technology is given', async () => {
    const result = await handleGetDocumentationUpdates('all', 'SwiftUI');

    expect(result).toContain('## September 2026');
    expect(httpClient.getJson).toHaveBeenCalledWith(
      'https://developer.apple.com/tutorials/data/documentation/updates/swiftui.json',
    );
  });

  it('auto without technology keeps the legacy index output', async () => {
    const result = await handleGetDocumentationUpdates('all');

    expect(result).toContain('Apple Developer Documentation Updates');
    expect(result).not.toContain('Showing ');
    expect(httpClient.getJson).toHaveBeenCalledWith(
      'https://developer.apple.com/tutorials/data/documentation/Updates.json',
    );
  });

  it('detail="index" wins over a technology and keeps the legacy index', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 50, 'index',
    );

    expect(result).toContain('Apple Developer Documentation Updates');
    expect(httpClient.getJson).toHaveBeenCalledWith(
      'https://developer.apple.com/tutorials/data/documentation/Updates.json',
    );
  });

  it('matches technology names case-, space- and hyphen-insensitively', async () => {
    mockTimeline();
    const result = await handleGetDocumentationUpdates(
      'all', '  swift-UI ', undefined, undefined, true, 50, 'timeline',
    );

    expect(result).toContain('# SwiftUI Documentation Updates');
  });

  it('resolves pages exposed only through the index references map', async () => {
    mockTimeline(timelineDocument, {
      interfaceLanguages: { swift: [] },
      references: {
        'doc://com.apple.Updates/documentation/updates/swiftui': {
          title: 'SwiftUI updates',
          url: '/documentation/updates/swiftui',
        },
      },
    });

    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 50, 'timeline',
    );

    expect(result).toContain('## September 2026');
  });

  it('reports unknown technologies with valid examples', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'NotARealFramework', undefined, undefined, true, 50, 'timeline',
    );

    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('Unknown technology "NotARealFramework"');
    expect(result).toContain('SwiftUI updates');
    expect(result).toContain('App Intents updates');
  });

  it('errors when detail="timeline" is used without a technology', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', undefined, undefined, undefined, true, 50, 'timeline',
    );

    expect(result.startsWith('Error:')).toBe(true);
    expect(result).toContain('requires a technology');
  });

  it('applies limit to change entries across sections', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 2, 'timeline',
    );

    expect(result).toContain('Showing 2 of 5 changes');
    expect(result).toContain('## September 2026');
    expect(result).not.toContain('## June 2025');
  });

  it('filters sections by year', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', '2025', undefined, true, 50, 'timeline',
    );

    expect(result).toContain('## June 2025');
    expect(result).not.toContain('September 2026');
    expect(result).toContain('Showing 1 of 1 changes · sections: 1');
  });

  it('filters entries by searchQuery', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, 'widgets', true, 50, 'timeline',
    );

    expect(result).toContain('## June 2025');
    expect(result).not.toContain('September 2026');
    expect(result).toContain('Showing 1 of 1 changes');
  });

  it('truncates long change text to ~400 characters', async () => {
    const longText = 'x'.repeat(1200);
    mockTimeline({
      ...timelineDocument,
      primaryContentSections: [{
        kind: 'content',
        content: [
          { type: 'heading', level: 2, text: 'September 2026' },
          { type: 'paragraph', inlineContent: [{ type: 'text', text: longText }] },
        ],
      }],
    });

    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 50, 'timeline',
    );

    const entry = result.split('\n').find(line => line.startsWith('- ')) ?? '';
    expect(entry.endsWith('…')).toBe(true);
    expect(entry.length).toBeLessThanOrEqual(402);
  });

  it('caps the whole output at ~14K characters and says so', async () => {
    const manyEntries = Array.from({ length: 200 }, (_, index) => ({
      type: 'unorderedList',
      items: [{ content: [{
        type: 'paragraph',
        inlineContent: [{ type: 'text', text: `Change ${index} ${'y'.repeat(300)}` }],
      }] }],
    }));
    mockTimeline({
      metadata: { title: 'SwiftUI updates' },
      abstract: [{ type: 'text', text: 'Learn about important changes to SwiftUI.' }],
      primaryContentSections: [{
        kind: 'content',
        content: [
          { type: 'heading', level: 2, text: 'September 2026' },
          ...manyEntries,
        ],
      }],
    });

    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 200, 'timeline',
    );

    expect(result.length).toBeLessThanOrEqual(14000);
    expect(result).toContain('output truncated');
  });

  it('caches the timeline keyed by detail/slug/filters', async () => {
    (updatesCache.get as jest.Mock).mockReturnValue('# Cached Timeline');

    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', '2025', 'text', true, 30, 'timeline',
    );

    expect(result).toBe('# Cached Timeline');
    const cacheKey = (updatesCache.get as jest.Mock).mock.calls[0][0] as string;
    expect(cacheKey).toContain('documentation-updates-timeline');
    expect(cacheKey).toContain('swiftui');
    expect(cacheKey).toContain('2025');
    expect(cacheKey).toContain('text');
    expect(updatesCache.set).not.toHaveBeenCalled();
    // Only the index was needed to resolve the slug; the doc was never fetched.
    expect(httpClient.getJson).not.toHaveBeenCalledWith(
      expect.stringContaining('documentation/updates/swiftui.json'),
    );
  });

  it('stores timeline results under a slug-scoped cache key', async () => {
    await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, 'widgets', true, 30, 'timeline',
    );

    expect(updatesCache.set).toHaveBeenCalled();
    const [cacheKey, cachedValue] = (updatesCache.set as jest.Mock).mock.calls[0];
    expect(cacheKey).toContain('documentation-updates-timeline');
    expect(cacheKey).toContain('swiftui');
    expect(cacheKey).toContain('widgets');
    expect(cachedValue).toContain('## June 2025');
  });

  it('returns a no-match message when filters exclude everything', async () => {
    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', '1999', undefined, true, 50, 'timeline',
    );

    expect(result).toContain('No dated updates found for SwiftUI updates in 1999');
  });

  it('surfaces fetch failures as an Error string', async () => {
    (httpClient.getJson as jest.Mock).mockImplementation((url: unknown) => {
      const urlStr = url as string;
      if (urlStr.includes('index/updates')) {
        return Promise.resolve(timelineIndex);
      }
      return Promise.reject(new Error('Network error'));
    });

    const result = await handleGetDocumentationUpdates(
      'all', 'SwiftUI', undefined, undefined, true, 50, 'timeline',
    );

    expect(result.startsWith('Error: Failed to fetch documentation updates')).toBe(true);
    expect(result).toContain('Network error');
  });
});

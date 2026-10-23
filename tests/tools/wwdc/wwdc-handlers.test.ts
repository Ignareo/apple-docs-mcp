/**
 * Tests for WWDC handlers
 */

import {
  handleListWWDCVideos,
  handleSearchWWDCContent,
  handleGetWWDCVideo,
  handleGetWWDCCodeExamples,
  handleBrowseWWDCTopics,
  handleFindRelatedWWDCVideos,
  handleListWWDCYears,
} from '../../../src/tools/wwdc/wwdc-handlers';

// Mock the data source module
jest.mock('../../../src/utils/wwdc-data-source', () => ({
  loadGlobalMetadata: jest.fn(),
  loadTopicIndex: jest.fn(),
  loadYearIndex: jest.fn(),
  loadVideoData: jest.fn(),
  loadAllVideos: jest.fn(),
  clearDataCache: jest.fn(),
  isDataAvailable: jest.fn(),
}));

import {
  loadGlobalMetadata,
  loadTopicIndex,
  loadYearIndex,
  loadVideoData,
  loadAllVideos,
} from '../../../src/utils/wwdc-data-source';

const mockLoadGlobalMetadata = loadGlobalMetadata as jest.MockedFunction<typeof loadGlobalMetadata>;
const mockLoadTopicIndex = loadTopicIndex as jest.MockedFunction<typeof loadTopicIndex>;
const mockLoadYearIndex = loadYearIndex as jest.MockedFunction<typeof loadYearIndex>;
const mockLoadVideoData = loadVideoData as jest.MockedFunction<typeof loadVideoData>;
const mockLoadAllVideos = loadAllVideos as jest.MockedFunction<typeof loadAllVideos>;

// Helper to convert video ID to file path
const videoIdToPath = (id: string, year: string = '2025') => `videos/${year}-${id}.json`;

describe('WWDC Handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleListWWDCVideos', () => {
    const mockMetadata = {
      version: '1.0',
      lastUpdated: '2025-01-01',
      totalVideos: 1266,
      topics: [
        { id: 'swiftui-ui-frameworks', name: 'SwiftUI & UI Frameworks', url: 'https://developer.apple.com/videos/topics/swiftui-ui-frameworks' },
        { id: 'machine-learning-ai', name: 'Machine Learning & AI', url: 'https://developer.apple.com/videos/topics/machine-learning-ai' },
      ],
      years: ['2025', '2024', '2023'],
      statistics: {
        byTopic: {},
        byYear: {},
        videosWithCode: 500,
        videosWithTranscript: 1200,
        videosWithResources: 800,
      },
    };

    const mockVideo = {
      id: '10188',
      url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
      title: 'Meet the Translation API',
      duration: '15 min',
      topics: ['Machine Learning & AI'],
      hasTranscript: true,
      hasCode: true,
      hasResources: true,
      relatedVideos: [],
      year: '2025',
      resources: {},
    };

    beforeEach(() => {
      mockLoadGlobalMetadata.mockResolvedValue(mockMetadata);
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        if (year === '2025' && videoId === '10188') {
          return Promise.resolve(mockVideo);
        }
        return Promise.reject(new Error('Video not found'));
      });
    });

    test('should list all videos when no filters provided', async () => {
      const mockYearIndex = {
        year: '2025',
        videoCount: 1,
        videos: [{ id: '10188', year: '2025', title: 'Meet the Translation API', topics: ['Machine Learning & AI'], duration: '15 min', hasCode: true, hasTranscript: true, dataFile: 'videos/2025-10188.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10188/' }],
      };

      mockLoadYearIndex.mockResolvedValue(mockYearIndex);

      const result = await handleListWWDCVideos();

      expect(result).toContain('WWDC Video List');
      expect(result).toContain('Meet the Translation API');
      // The year-index mock resolves for every year in metadata, so all 3 appear.
      expect(result).toContain('Showing 3 of 3 videos');
      expect(result).toContain('videoId: 10188');
      expect(mockLoadGlobalMetadata).toHaveBeenCalled();
      expect(mockLoadYearIndex).toHaveBeenCalledWith('2025');
    });

    test('should report showing X of Y when limit truncates the list', async () => {
      const mockYearIndex = {
        year: '2025',
        videoCount: 2,
        videos: [
          { id: '10188', year: '2025', title: 'Meet the Translation API', topics: ['Machine Learning & AI'], duration: '15 min', hasCode: true, hasTranscript: true, dataFile: 'videos/2025-10188.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10188/' },
          { id: '10189', year: '2025', title: 'Second Video', topics: ['Machine Learning & AI'], duration: '20 min', hasCode: false, hasTranscript: true, dataFile: 'videos/2025-10189.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10189/' },
        ],
      };
      mockLoadYearIndex.mockResolvedValue(mockYearIndex);
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        const video = mockYearIndex.videos.find(v => v.id === videoId);
        return video ? Promise.resolve(video as any) : Promise.reject(new Error('Video not found'));
      });

      const result = await handleListWWDCVideos('2025', undefined, undefined, 1);

      expect(result).toContain('Showing 1 of 2 videos');
      expect(result).toContain('videoId: 10188');
      expect(result).not.toContain('videoId: 10189');
    });

    test('should reject an unknown year with valid options and snapshot', async () => {
      const result = await handleListWWDCVideos('2026');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown WWDC year "2026"');
      expect(result).toContain('Valid years: 2025, 2024, 2023');
      expect(result).toContain('Snapshot: 2025-01-01 · 2023–2025 · 1,266 sessions');
      expect(result).not.toContain('No WWDC videos found');
    });

    test('should accept a valid year (2019) and only report empty results, not an invalid-year error', async () => {
      // 2019 is a valid bundled year, so it must never be reported as invalid.
      mockLoadGlobalMetadata.mockResolvedValue({
        ...mockMetadata,
        years: ['2025', '2024', '2023', '2019'],
      });
      mockLoadYearIndex.mockResolvedValue({ year: '2019', videoCount: 0, topics: [], videos: [] });

      const result = await handleListWWDCVideos('2019');

      expect(result).not.toContain('Unknown WWDC year');
      expect(result).toContain('No WWDC videos found');
    });

    test('should reject an unknown topic id with valid options', async () => {
      const result = await handleListWWDCVideos(undefined, 'not-a-topic');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown WWDC topic "not-a-topic"');
      expect(result).toContain('Valid topics:');
      expect(result).toContain('swiftui-ui-frameworks');
      expect(result).toContain('Snapshot:');
    });

    test('should filter videos by year', async () => {
      const mockYearIndex = {
        year: '2025',
        videoCount: 1,
        topics: ['Machine Learning & AI'],
        videos: [{ 
          id: '10188', 
          year: '2025',
          title: 'Meet the Translation API',
          topics: ['Machine Learning & AI'],
          duration: '15 min',
          hasCode: true,
          hasTranscript: true,
          dataFile: 'videos/2025-10188.json' 
        }],
      };

      mockLoadYearIndex.mockResolvedValue(mockYearIndex);

      const result = await handleListWWDCVideos('2025');

      expect(result).toContain('WWDC2025');
      expect(result).toContain('Meet the Translation API');
      expect(mockLoadYearIndex).toHaveBeenCalledWith('2025');
      expect(mockLoadYearIndex).toHaveBeenCalledTimes(1);
    });

    test('should filter videos by topic', async () => {
      const mockTopicIndex = {
        topicId: 'machine-learning-ai',
        name: 'Machine Learning & AI',
        videoCount: 1,
        videos: [{ id: '10188', year: '2025', dataFile: 'videos/10188.json' }],
      };

      mockLoadTopicIndex.mockResolvedValue(mockTopicIndex);

      const result = await handleListWWDCVideos(undefined, 'machine-learning-ai');

      expect(result).toContain('Machine Learning & AI');
      expect(result).toContain('Meet the Translation API');
      expect(mockLoadTopicIndex).toHaveBeenCalledWith('machine-learning-ai');
    });

    test('should filter videos by code availability', async () => {
      const mockYearIndex = {
        year: '2025',
        videoCount: 2,
        videos: [
          { id: '10188', year: '2025', title: 'Meet the Translation API', topics: ['Machine Learning & AI'], duration: '15 min', hasCode: true, hasTranscript: true, dataFile: 'videos/2025-10188.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10188/' },
          { id: '10189', year: '2025', title: 'No Code Video', topics: ['Machine Learning & AI'], duration: '20 min', hasCode: false, hasTranscript: true, dataFile: 'videos/2025-10189.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10189/' },
        ],
      };

      const mockVideoWithCode = { ...mockVideo, hasCode: true };
      const mockVideoWithoutCode = { ...mockVideo, id: '10189', title: 'No Code Video', hasCode: false };

      mockLoadYearIndex.mockResolvedValue(mockYearIndex);
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        if (videoId === '10188') return Promise.resolve(mockVideoWithCode);
        if (videoId === '10189') return Promise.resolve(mockVideoWithoutCode);
        return Promise.reject(new Error('Video not found'));
      });

      const result = await handleListWWDCVideos('2025', undefined, true);

      expect(result).toContain('Meet the Translation API');
      expect(result).not.toContain('No Code Video');
    });

    test('should handle errors gracefully', async () => {
      mockLoadGlobalMetadata.mockRejectedValue(new Error('Failed to load metadata'));

      const result = await handleListWWDCVideos();

      expect(result).toContain('Error: Failed to list WWDC videos');
      expect(result).toContain('Failed to load metadata');
    });
  });

  describe('handleSearchWWDCContent', () => {
    const mockSearchVideo = {
      id: '10188',
      url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
      title: 'Meet the Translation API',
      description: 'Discover how you can translate text across different languages',
      duration: '15 min',
      topics: ['Machine Learning & AI'],
      hasTranscript: true,
      hasCode: true,
      hasResources: true,
      transcript: {
        fullText: 'Welcome to Meet the Translation API\nToday we will explore async await patterns',
        segments: [
          { timestamp: '00:00', text: 'Welcome to Meet the Translation API' },
          { timestamp: '00:30', text: 'Today we will explore async await patterns' },
        ],
      },
      codeExamples: [
        {
          language: 'swift',
          platform: 'iOS',
          title: 'Basic Translation',
          code: 'let translation = await translator.translate("Hello")',
        },
      ],
      year: '2025',
      relatedVideos: [],
      resources: {},
    };

    beforeEach(() => {
      mockLoadGlobalMetadata.mockResolvedValue({
        version: '1.0',
        lastUpdated: '2025-01-01',
        totalVideos: 1266,
        topics: [],
        years: ['2025', '2024', '2019'],
        statistics: {
          byTopic: {
            'swiftui-ui-frameworks': 50,
            'machine-learning-ai': 30,
          },
          byYear: {},
          videosWithCode: 500,
          videosWithTranscript: 1200,
          videosWithResources: 800,
        },
      });

      const searchYearIndex = {
        year: '2025',
        videoCount: 1,
        topics: ['Machine Learning & AI'],
        videos: [{ 
          id: '10188', 
          year: '2025',
          title: 'Meet the Translation API',
          topics: ['Machine Learning & AI'],
          duration: '15 min',
          hasCode: true,
          hasTranscript: true,
          dataFile: 'videos/2025-10188.json' 
        }],
      };
      mockLoadYearIndex.mockImplementation((year: string) => Promise.resolve(
        year === '2025'
          ? searchYearIndex
          : { year, videoCount: 0, topics: [], videos: [] },
      ));

      mockLoadVideoData.mockResolvedValue(mockSearchVideo);
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        if (videoId === '10188') return Promise.resolve(mockSearchVideo);
        return Promise.reject(new Error('Video not found'));
      });
    });

    test('should search in transcripts', async () => {
      const result = await handleSearchWWDCContent('async await', 'transcript');

      expect(result).toContain('WWDC Content Search Results');
      expect(result).toContain('Meet the Translation API');
      expect(result).toContain('async await patterns');
      expect(mockLoadVideoData).toHaveBeenCalled();
    });

    test('should search in code examples', async () => {
      const result = await handleSearchWWDCContent('translator', 'code');

      expect(result).toContain('WWDC Content Search Results');
      expect(result).toContain('[swift] Basic Translation');
      expect(result).toContain('translator.translate');
    });

    test('should search in both transcript and code', async () => {
      const result = await handleSearchWWDCContent('translate', 'both');

      expect(result).toContain('Meet the Translation API');
      expect(result).toContain('translator.translate');
    });

    test('should filter by year', async () => {
      const result = await handleSearchWWDCContent('translate', 'both', '2025');

      expect(result).toContain('Meet the Translation API');
      expect(mockLoadYearIndex).toHaveBeenCalledWith('2025');
      expect(mockLoadYearIndex).toHaveBeenCalledTimes(1);
    });

    test('should filter by language', async () => {
      const result = await handleSearchWWDCContent('translate', 'code', undefined, 'swift');

      expect(result).toContain('Basic Translation');
      expect(result).toContain('[swift]');
    });

    test('should handle no results', async () => {
      const result = await handleSearchWWDCContent('nonexistent', 'both');

      expect(result).toContain('No content found');
    });

    test('should report total matches and truncate snippets to snippetChars', async () => {
      const result = await handleSearchWWDCContent(
        'async await',
        'transcript',
        undefined,
        undefined,
        10,
        { snippetChars: 20 },
      );

      expect(result).toContain('Total matches: 1 (showing 1)');
      expect(result).toContain('[snippet truncated: showing 20 of');
      const snippetLines = result.split('\n').filter(line => line.startsWith('> '));
      expect(snippetLines).toHaveLength(1);
      expect(snippetLines[0].length).toBeLessThanOrEqual(20 + 120);
    });

    test('should honour matchesPerVideo when a video has multiple matches', async () => {
      const defaultResult = await handleSearchWWDCContent('e', 'transcript');
      expect(defaultResult).toContain('Total matches: 2 (showing 1)');

      const allMatchesResult = await handleSearchWWDCContent(
        'e',
        'transcript',
        undefined,
        undefined,
        10,
        { matchesPerVideo: 2, snippetChars: 20 },
      );
      expect(allMatchesResult).toContain('Total matches: 2 (showing 2)');
    });

    test('should reject an unknown year instead of returning no content', async () => {
      const result = await handleSearchWWDCContent('translate', 'both', '2026');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown WWDC year "2026"');
      expect(result).toContain('Valid years:');
      expect(result).toContain('2025');
      expect(result).toContain('Snapshot: 2025-01-01 · 2019–2025 · 1,266 sessions');
      expect(result).not.toContain('No content found');
    });

    test('should treat the valid year 2019 as valid and report no content for a non-matching query', async () => {
      const result = await handleSearchWWDCContent('definitely-not-present', 'both', '2019');

      expect(result).not.toMatch(/^Error: /);
      expect(result).toContain('No content found');
    });

    test('should reject an unknown language with valid options', async () => {
      const result = await handleSearchWWDCContent('translate', 'code', undefined, 'python');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown code language "python"');
      expect(result).toContain('Valid languages: swift');
      expect(result).toContain('Snapshot:');
    });

    test('should handle errors gracefully', async () => {
      mockLoadGlobalMetadata.mockRejectedValue(new Error('Search failed'));

      const result = await handleSearchWWDCContent('test');

      expect(result).toContain('Error: Failed to search WWDC content');
      expect(result).toContain('Search failed');
    });
  });

  describe('handleGetWWDCVideo', () => {
    const mockFullVideo = {
      id: '10188',
      url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
      title: 'Meet the Translation API',
      duration: '15 min',
      topics: ['Machine Learning & AI'],
      hasTranscript: true,
      hasCode: true,
      hasResources: true,
      transcript: {
        fullText: 'Welcome to the session\nLet us begin',
        segments: [
          { timestamp: '00:00', text: 'Welcome to the session' },
          { timestamp: '00:30', text: 'Let us begin' },
        ],
      },
      codeExamples: [
        {
          language: 'swift',
          platform: 'iOS',
          title: 'Example Code',
          code: 'let example = "code"',
        },
      ],
      resources: {
        resourceLinks: [
          { title: 'Download Sample', url: 'https://example.com/sample' },
        ],
      },
      relatedVideos: [
        { id: '10189', year: '2025', title: 'Related Video 1', url: 'https://example.com/10189' },
        { id: '10190', year: '2025', title: 'Related Video 2', url: 'https://example.com/10190' },
      ],
      year: '2025',
    };

    beforeEach(() => {
      mockLoadVideoData.mockResolvedValue(mockFullVideo);
    });

    test('should get full video details with transcript and code', async () => {
      const result = await handleGetWWDCVideo('2025', '10188');

      expect(result).toContain('Meet the Translation API');
      expect(result).toContain('Welcome to the session');
      expect(result).toContain('Example Code');
      expect(result).toContain('Download Sample');
      expect(mockLoadVideoData).toHaveBeenCalledWith('2025', '10188');
    });

    test('should exclude transcript when requested', async () => {
      const result = await handleGetWWDCVideo('2025', '10188', false, true);

      expect(result).toContain('Meet the Translation API');
      expect(result).not.toContain('Welcome to the session');
      expect(result).toContain('Example Code');
    });

    test('should exclude code when requested', async () => {
      const result = await handleGetWWDCVideo('2025', '10188', true, false);

      expect(result).toContain('Meet the Translation API');
      expect(result).toContain('Welcome to the session');
      expect(result).not.toContain('Example Code');
    });

    test('should cap the transcript and stay within the budget', async () => {
      const largeVideo = {
        id: '10018',
        year: '2021',
        title: 'T',
        duration: '',
        topics: [],
        hasTranscript: true,
        hasCode: false,
        url: 'u',
        transcript: { fullText: 'x'.repeat(30000), segments: [] },
        resources: {},
        relatedVideos: [],
      };
      mockLoadVideoData.mockResolvedValue(largeVideo as any);

      const result = await handleGetWWDCVideo('2021', '10018', true, false, {
        maxTranscriptChars: 500,
        includeResources: false,
        includeRelatedVideos: false,
      });

      expect(result).toContain('[transcript truncated: showing 500 of 30000 chars — pass query or raise maxTranscriptChars]');
      expect(result.length).toBeLessThanOrEqual(500 + 200);
    });

    test('should not truncate when maxTranscriptChars is 0 (unlimited)', async () => {
      const largeVideo = {
        id: '10018',
        year: '2021',
        title: 'T',
        duration: '',
        topics: [],
        hasTranscript: true,
        hasCode: false,
        url: 'u',
        transcript: { fullText: 'y'.repeat(30000), segments: [] },
        resources: {},
        relatedVideos: [],
      };
      mockLoadVideoData.mockResolvedValue(largeVideo as any);

      const result = await handleGetWWDCVideo('2021', '10018', true, false, {
        maxTranscriptChars: 0,
        includeResources: false,
        includeRelatedVideos: false,
      });

      expect(result).not.toContain('[transcript truncated');
      expect(result).toContain('y'.repeat(30000));
    });

    test('should narrow the transcript to query windows with one line of context', async () => {
      const windowedVideo = {
        id: '10018',
        year: '2021',
        title: 'T',
        duration: '',
        topics: [],
        hasTranscript: true,
        hasCode: false,
        url: 'u',
        transcript: {
          fullText: [
            'line1',
            'line2',
            'target here',
            'line4',
            'line5',
            'line6',
            'line7',
            'target two',
            'line9',
            'line10',
          ].join('\n'),
          segments: [],
        },
        resources: {},
        relatedVideos: [],
      };
      mockLoadVideoData.mockResolvedValue(windowedVideo as any);

      const result = await handleGetWWDCVideo('2021', '10018', true, false, {
        query: 'target',
        includeResources: false,
        includeRelatedVideos: false,
      });

      expect(result).toContain('*Keyword filter: "target" (2 matching lines of 10)*');
      expect(result).toContain('target here');
      expect(result).toContain('target two');
      expect(result).toContain('line2');
      expect(result).toContain('...');
      expect(result).not.toContain('line1');
      expect(result).not.toContain('line10');
    });

    test('should report when a query matches no transcript lines', async () => {
      const result = await handleGetWWDCVideo('2025', '10188', true, false, {
        query: 'definitely-not-there',
      });

      expect(result).toContain('No transcript lines matched "definitely-not-there"');
    });

    test('should respect includeResources and includeRelatedVideos', async () => {
      const result = await handleGetWWDCVideo('2025', '10188', false, false, {
        includeResources: false,
        includeRelatedVideos: false,
      });

      expect(result).toContain('Meet the Translation API');
      expect(result).not.toContain('Download Sample');
      expect(result).not.toContain('Related Video 1');
      expect(result).not.toContain('## Related Videos');
    });

    test('should cap each code example at 1500 chars with a marker', async () => {
      const codeVideo = {
        ...mockFullVideo,
        transcript: undefined,
        codeExamples: [
          { language: 'swift', title: 'Big Example', code: 'a'.repeat(4000) },
        ],
      };
      mockLoadVideoData.mockResolvedValue(codeVideo as any);

      const result = await handleGetWWDCVideo('2025', '10188', false, true, {
        includeResources: false,
        includeRelatedVideos: false,
      });

      expect(result).toContain('[code example truncated: showing 1500 of 4000 chars]');
      expect(result).not.toContain('a'.repeat(1501));
    });

    test('should handle missing video', async () => {
      mockLoadVideoData.mockRejectedValue(new Error('Video not found'));

      const result = await handleGetWWDCVideo('2025', '99999');

      expect(result).toContain('Error: Failed to get WWDC video');
      expect(result).toContain('Video not found');
    });
  });

  describe('handleGetWWDCCodeExamples', () => {
    const mockVideosWithCode = [
      {
        id: '10188',
        url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
        title: 'SwiftUI Animations',
        year: '2025',
        duration: '30 min',
        topics: ['SwiftUI & UI Frameworks'],
        hasTranscript: true,
        hasCode: true,
        resources: {},
        codeExamples: [
          {
            language: 'swift',
            platform: 'iOS',
            title: 'Animation Example',
            code: 'import SwiftUI\n\nwithAnimation { state.toggle() }',
          },
        ],
      },
      {
        id: '10189',
        url: 'https://developer.apple.com/videos/play/wwdc2025/10189/',
        title: 'UIKit Updates',
        year: '2025',
        duration: '25 min',
        topics: ['UIKit'],
        hasTranscript: true,
        hasCode: true,
        resources: {},
        codeExamples: [
          {
            language: 'swift',
            platform: 'iOS',
            title: 'UIKit Example',
            code: 'let view = UIView()',
          },
        ],
      },
    ];

    beforeEach(() => {
      mockLoadGlobalMetadata.mockResolvedValue({
        version: '1.0',
        lastUpdated: '2025-01-01',
        totalVideos: 1266,
        topics: [],
        years: ['2025'],
        statistics: {
          byTopic: {
            'swiftui-ui-frameworks': 50,
            'machine-learning-ai': 30,
          },
          byYear: {},
          videosWithCode: 500,
          videosWithTranscript: 1200,
          videosWithResources: 800,
        },
      });

      mockLoadYearIndex.mockResolvedValue({
        year: '2025',
        videoCount: 2,
        topics: ['SwiftUI & UI Frameworks', 'UIKit'],
        videos: [
          { id: '10188', year: '2025', title: 'SwiftUI Animations', topics: ['SwiftUI & UI Frameworks'], duration: '30 min', hasCode: true, hasTranscript: true, dataFile: 'videos/2025-10188.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10188/' },
          { id: '10189', year: '2025', title: 'UIKit Updates', topics: ['UIKit'], duration: '25 min', hasCode: true, hasTranscript: true, dataFile: 'videos/2025-10189.json', url: 'https://developer.apple.com/videos/play/wwdc2025/10189/' },
        ],
      });

      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        const video = mockVideosWithCode.find(v => v.id === videoId);
        if (video) {
          return Promise.resolve(video as any);
        }
        return Promise.reject(new Error('Video not found'));
      });
    });

    test('should get all code examples', async () => {
      const result = await handleGetWWDCCodeExamples();

      expect(result).toContain('WWDC Code Examples');
      expect(result).toContain('Animation Example');
      expect(result).toContain('UIKit Example');
      expect(result).toContain('Total examples: 2 (showing 2)');
    });

    test('should cap code examples with maxCodeChars and report the total', async () => {
      const bigCodeVideo = {
        ...mockVideosWithCode[0],
        codeExamples: [
          { language: 'swift', title: 'Huge Example', code: 'z'.repeat(5000) },
        ],
      };
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        if (videoId === '10188') return Promise.resolve(bigCodeVideo as any);
        return Promise.reject(new Error('Video not found'));
      });

      const result = await handleGetWWDCCodeExamples(
        undefined,
        undefined,
        undefined,
        undefined,
        30,
        { maxCodeChars: 1000 },
      );

      expect(result).toContain('Total examples: 1 (showing 1)');
      expect(result).toContain('[code example truncated: showing 1000 of 5000 chars]');
      expect(result).not.toContain('z'.repeat(1001));
    });

    test('should reject an unknown year instead of returning no examples', async () => {
      const result = await handleGetWWDCCodeExamples(undefined, undefined, '2026');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown WWDC year "2026"');
      expect(result).toContain('Valid years:');
      expect(result).toContain('Snapshot: 2025-01-01');
      expect(result).not.toContain('No code examples found');
    });

    test('should reject an unknown language with valid options', async () => {
      const result = await handleGetWWDCCodeExamples(undefined, undefined, undefined, 'python');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown code language "python"');
      expect(result).toContain('Valid languages: swift');
      expect(result).toContain('Snapshot:');
    });

    test('should reject an unknown topic id with valid options', async () => {
      const result = await handleGetWWDCCodeExamples(undefined, 'not-a-topic');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown WWDC topic "not-a-topic"');
      expect(result).toContain('Valid topics:');
      expect(result).toContain('Snapshot:');
    });

    test('should filter by framework', async () => {
      const result = await handleGetWWDCCodeExamples('SwiftUI');

      expect(result).toContain('Animation Example');
      expect(result).not.toContain('UIKit Example');
    });

    test('should filter by language', async () => {
      const result = await handleGetWWDCCodeExamples(undefined, undefined, undefined, 'swift');

      expect(result).toContain('Animation Example');
      expect(result).toContain('Language: swift');
    });

    test('should handle no code examples', async () => {
      const videosWithoutCode = mockVideosWithCode.map(v => ({
        ...v,
        codeExamples: [],
      }));
      
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        const video = videosWithoutCode.find(v => v.id === videoId);
        if (video) {
          return Promise.resolve(video as any);
        }
        return Promise.reject(new Error('Video not found'));
      });

      const result = await handleGetWWDCCodeExamples();

      expect(result).toContain('No code examples found');
    });
  });

  describe('handleBrowseWWDCTopics', () => {
    const mockTopics = [
      {
        topicId: 'swiftui-ui-frameworks',
        name: 'SwiftUI & UI Frameworks',
        videoCount: 50,
        videos: [
          { 
            id: '10188', 
            year: '2025', 
            title: 'SwiftUI Animations',
            topics: ['SwiftUI & UI Frameworks'],
            duration: '20 min',
            hasCode: true,
            hasTranscript: true,
            url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
            dataFile: 'videos/2025-10188.json' 
          },
        ],
      },
      {
        topicId: 'machine-learning-ai',
        name: 'Machine Learning & AI',
        videoCount: 30,
        videos: [],
      },
    ];

    beforeEach(() => {
      mockLoadGlobalMetadata.mockResolvedValue({
        version: '1.0',
        lastUpdated: '2025-01-01',
        totalVideos: 1266,
        topics: mockTopics.map(t => ({
          id: t.topicId,
          name: t.name,
          url: `https://developer.apple.com/videos/topics/${t.topicId}`,
        })),
        years: ['2025'],
        statistics: {
          byTopic: {
            'swiftui-ui-frameworks': 50,
            'machine-learning-ai': 30,
          },
          byYear: {},
          videosWithCode: 500,
          videosWithTranscript: 1200,
          videosWithResources: 800,
        },
      });

      mockLoadTopicIndex.mockImplementation((topicId) => {
        const topic = mockTopics.find(t => t.topicId === topicId);
        return Promise.resolve(topic as any);
      });

      const mockTranscriptVideo = {
        id: '10188',
        url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
        title: 'SwiftUI Animations',
        year: '2025',
        topics: ['SwiftUI & UI Frameworks'],
        duration: '20 min',
        hasTranscript: true,
        hasCode: true,
        resources: {},
      };

      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        if (videoId === '10188') return Promise.resolve(mockTranscriptVideo);
        return Promise.reject(new Error('Video not found'));
      });
    });

    test('should list all topics when no topicId provided', async () => {
      const result = await handleBrowseWWDCTopics();

      expect(result).toContain('WWDC Topics');
      expect(result).toContain('SwiftUI & UI Frameworks');
      expect(result).toContain('Machine Learning & AI');
      expect(result).toContain('**Videos:** 50');
      expect(result).toContain('**Videos:** 30');
    });

    test('should show specific topic with videos', async () => {
      const result = await handleBrowseWWDCTopics('swiftui-ui-frameworks');

      expect(result).toContain('SwiftUI & UI Frameworks');
      expect(result).toContain('SwiftUI Animations');
      expect(mockLoadTopicIndex).toHaveBeenCalledWith('swiftui-ui-frameworks');
    });

    test('should exclude videos when requested', async () => {
      const result = await handleBrowseWWDCTopics('swiftui-ui-frameworks', false);

      expect(result).toContain('SwiftUI & UI Frameworks');
      expect(result).not.toContain('SwiftUI Animations');
    });

    test('should handle topic not found with valid options', async () => {
      const result = await handleBrowseWWDCTopics('invalid-topic');

      expect(result).toMatch(/^Error: /);
      expect(result).toContain('Unknown WWDC topic "invalid-topic"');
      expect(result).toContain('Valid topics:');
      expect(result).toContain('swiftui-ui-frameworks');
      expect(result).toContain('Snapshot:');
    });
  });

  describe('handleFindRelatedWWDCVideos', () => {
    const mockSourceVideo = {
      id: '10188',
      title: 'SwiftUI Basics',
      year: '2025',
      url: 'https://developer.apple.com/videos/play/wwdc2025/10188/',
      duration: '30 min',
      topics: ['SwiftUI & UI Frameworks'],
      relatedVideos: [
        { id: '10189', year: '2025', title: 'Advanced SwiftUI', url: 'https://example.com/10189' },
        { id: '10190', year: '2024', title: 'SwiftUI Performance', url: 'https://example.com/10190' },
      ],
      hasTranscript: true,
      hasCode: true,
      resources: {},
    };

    const mockRelatedVideos = [
      {
        id: '10189',
        title: 'Advanced SwiftUI',
        year: '2025',
        url: 'https://developer.apple.com/videos/play/wwdc2025/10189/',
        duration: '25 min',
        topics: ['SwiftUI & UI Frameworks'],
        hasTranscript: true,
        hasCode: true,
        resources: {},
      },
      {
        id: '10190',
        title: 'SwiftUI Performance',
        year: '2024',
        url: 'https://developer.apple.com/videos/play/wwdc2024/10190/',
        duration: '20 min',
        topics: ['SwiftUI & UI Frameworks', 'Performance'],
        hasTranscript: true,
        hasCode: false,
        resources: {},
      },
    ];

    beforeEach(() => {
      mockLoadVideoData.mockImplementation((year: string, videoId: string) => {
        if (videoId === '10188') return Promise.resolve(mockSourceVideo as any);
        const video = mockRelatedVideos.find(v => v.id === videoId);
        if (video) return Promise.resolve(video as any);
        return Promise.reject(new Error('Video not found'));
      });
    });

    test('should find explicitly related videos', async () => {
      const result = await handleFindRelatedWWDCVideos('10188', '2025');

      expect(result).toContain('Related Videos for "SwiftUI Basics"');
      expect(result).toContain('## Related Videos');
      expect(result).toContain('Advanced SwiftUI');
      expect(result).toContain('SwiftUI Performance');
    });

    test('should exclude explicit related when requested', async () => {
      const result = await handleFindRelatedWWDCVideos('10188', '2025', false, true, false);

      expect(result).toContain('Related Videos for "SwiftUI Basics"');
      // When no videos found
      expect(result).toContain('No related videos found');
    });

    test('should handle video not found', async () => {
      mockLoadVideoData.mockRejectedValue(new Error('Video not found'));

      const result = await handleFindRelatedWWDCVideos('99999', '2025');

      expect(result).toContain('Error: Failed to find related WWDC videos');
      expect(result).toContain('Video not found');
    });
  });

  describe('handleListWWDCYears', () => {
    test('should disclose the bundled data snapshot', async () => {
      mockLoadGlobalMetadata.mockResolvedValue({
        version: '2.0',
        lastUpdated: '2025-07-18T11:04:52.652Z',
        totalVideos: 1266,
        topics: [],
        years: ['2025', '2019', '2014'],
        statistics: {
          byTopic: {},
          byYear: { '2025': 100, '2019': 80, '2014': 90 },
          videosWithCode: 500,
          videosWithTranscript: 1200,
          videosWithResources: 800,
        },
      });

      const result = await handleListWWDCYears();

      expect(result).toContain('Snapshot: 2025-07-18 · 2014–2025 · 1,266 sessions');
      expect(result).toContain('**2025**: 100 videos');
    });
  });
});
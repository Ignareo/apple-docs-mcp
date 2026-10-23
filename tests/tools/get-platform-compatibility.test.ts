import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { handleGetPlatformCompatibility } from '../../src/tools/get-platform-compatibility.js';
import { httpClient } from '../../src/utils/http-client.js';
import { convertToJsonApiUrl } from '../../src/utils/url-converter.js';

jest.mock('../../src/utils/http-client.js');
jest.mock('../../src/utils/url-converter.js', () => ({
  convertToJsonApiUrl: jest.fn(),
  isValidAppleDeveloperUrl: jest.fn().mockReturnValue(true),
}));

const mockHttpClient = httpClient as jest.Mocked<typeof httpClient>;
const mockConvertToJsonApiUrl = convertToJsonApiUrl as jest.MockedFunction<typeof convertToJsonApiUrl>;

describe('get-platform-compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConvertToJsonApiUrl.mockReturnValue('https://developer.apple.com/documentation/swiftui/list.json');
  });

  describe('handleGetPlatformCompatibility', () => {
    const mockApiUrl = 'https://developer.apple.com/documentation/swiftui/list';
    const mockJsonResponse = {
      metadata: {
        title: 'List',
        platforms: [
          { name: 'iOS', introducedAt: '13.0' },
          { name: 'iPadOS', introducedAt: '13.0' },
          { name: 'macOS', introducedAt: '10.15' },
          { name: 'tvOS' },
        ],
      },
      references: {},
    };

    it('should render one compact availability table', async () => {
      mockHttpClient.getJson.mockResolvedValue(mockJsonResponse);

      const result = await handleGetPlatformCompatibility(mockApiUrl);

      expect(mockConvertToJsonApiUrl).toHaveBeenCalledWith(mockApiUrl);
      expect(result).toContain('# Platform Compatibility: [List]');
      expect(result).toContain('| Platform | Introduced | Deprecated | Notes |');
      expect(result).toContain('| iOS | 13.0 | - | - |');
      expect(result).toContain('| macOS | 10.15 | - | - |');
      // Platform without a version must not produce an empty pseudo-support line.
      expect(result).toContain('| tvOS | - | - | - |');

      // The old duplicated summary / recommendations / minimum-version blocks are gone.
      expect(result).not.toContain('Platform Support Summary');
      expect(result).not.toContain('Detailed Platform Information');
      expect(result).not.toContain('Compatibility Recommendations');
      expect(result).not.toContain('Minimum Version Requirements');
      expect(result).not.toContain('Cross-platform compatible');
      expect(result.length).toBeLessThan(400);
    });

    it('should warn about deprecation instead of claiming compatibility', async () => {
      const deprecatedResponse = {
        metadata: {
          title: 'UIAlertView',
          platforms: [
            {
              name: 'iOS',
              introducedAt: '2.0',
              deprecatedAt: '9.0',
              message: 'UIAlertView is deprecated. Use UIAlertController instead',
            },
            {
              name: 'iPadOS',
              introducedAt: '2.0',
              deprecatedAt: '9.0',
              message: 'UIAlertView is deprecated. Use UIAlertController instead',
            },
          ],
        },
        deprecationSummary: [
          {
            type: 'paragraph',
            inlineContent: [
              { type: 'text', text: 'Instead, use ' },
              {
                type: 'reference',
                identifier: 'doc://com.apple.uikit/documentation/UIKit/UIAlertController',
              },
              { type: 'text', text: '.' },
            ],
          },
        ],
        references: {
          'doc://com.apple.uikit/documentation/UIKit/UIAlertController': {
            title: 'UIAlertController',
            url: '/documentation/uikit/uialertcontroller',
          },
        },
      };

      mockHttpClient.getJson.mockResolvedValue(deprecatedResponse);

      const result = await handleGetPlatformCompatibility(mockApiUrl);

      expect(result).toContain('| iOS | 2.0 | 9.0 | - |');
      expect(result).toContain('⚠️ **Deprecated** — Instead, use UIAlertController.');
      expect(result).not.toContain('Cross-platform compatible');
      expect(result).not.toContain('✅');
    });

    it('should fall back to the platform migration message when no summary exists', async () => {
      mockHttpClient.getJson.mockResolvedValue({
        metadata: {
          title: 'NavigationView',
          platforms: [
            {
              name: 'iOS',
              introducedAt: '13.0',
              deprecatedAt: '27.2',
              message: 'Use NavigationStack or NavigationSplitView instead',
            },
          ],
        },
        references: {},
      });

      const result = await handleGetPlatformCompatibility(mockApiUrl);

      expect(result).toContain('⚠️ **Deprecated** — Use NavigationStack or NavigationSplitView instead');
    });

    it('should flag compareMode "framework" as unsupported in the output', async () => {
      mockHttpClient.getJson.mockResolvedValue(mockJsonResponse);

      const result = await handleGetPlatformCompatibility(mockApiUrl, 'framework');

      expect(result).toContain('compareMode "framework" is not supported');
      expect(result).toContain('Showing single-API compatibility instead');
      expect(result).toContain('| Platform | Introduced | Deprecated | Notes |');
      expect(result).not.toContain('Related APIs Compatibility');
    });

    it('should include compact related API tables when requested', async () => {
      mockHttpClient.getJson
        .mockResolvedValueOnce({
          metadata: {
            title: 'List',
            platforms: [{ name: 'iOS', introducedAt: '13.0' }],
          },
          topicSections: [{ title: 'Creating a list', identifiers: ['swiftui/list/init'] }],
          references: {
            'swiftui/list/init': { title: 'init(_:)', url: '/documentation/swiftui/list/init' },
          },
        })
        .mockResolvedValueOnce({
          metadata: {
            title: 'init(_:)',
            platforms: [{ name: 'iOS', introducedAt: '13.0' }],
          },
        });

      const result = await handleGetPlatformCompatibility(mockApiUrl, 'single', true);

      expect(result).toContain('## Related APIs Compatibility');
      expect(result).toContain('### Platform Compatibility: [init(_:)]');
    });

    it('should handle APIs without platform metadata', async () => {
      mockHttpClient.getJson.mockResolvedValue({ metadata: { title: 'No Platforms' } });

      const result = await handleGetPlatformCompatibility(mockApiUrl);

      expect(result).toContain('No platform information available for:');
    });

    it('should handle invalid URL', async () => {
      mockConvertToJsonApiUrl.mockReturnValue(null);

      const result = await handleGetPlatformCompatibility('invalid-url');

      expect(result).toContain('Error: get_platform_compatibility failed:');
      expect(result).toContain('Invalid Apple Developer Documentation URL');
    });

    it('should handle fetch errors', async () => {
      mockHttpClient.getJson.mockRejectedValue(new Error('Network error'));

      const result = await handleGetPlatformCompatibility(mockApiUrl);

      expect(result).toContain('Error: get_platform_compatibility failed:');
      expect(result).toContain('Network error');
    });
  });
});

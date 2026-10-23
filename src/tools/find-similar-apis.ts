import { convertToJsonApiUrl } from '../utils/url-converter.js';
import { httpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { PROCESSING_LIMITS, SEARCH_DEPTH_LIMITS } from '../utils/constants.js';
import { describeError, describeToolError } from '../utils/error-handler.js';

/**
 * Where a "similar" API was discovered. This is honest provenance, not a score.
 */
type SimilarSource = 'See Also' | 'Topic Group' | 'Deep Related';

const SOURCE_ORDER: Record<SimilarSource, number> = {
  'See Also': 0,
  'Topic Group': 1,
  'Deep Related': 2,
};

/**
 * Similar API information (no fabricated similarity score).
 */
interface SimilarAPI {
  title: string;
  url: string;
  identifier: string;
  abstract?: string;
  category: string;
  source: SimilarSource;
  symbolKind?: string;
  platforms?: string[];
  deprecated: boolean;
}

interface SeeAlsoSection {
  title: string;
  identifiers: string[];
}

interface TopicSection {
  title: string;
  identifiers: string[];
}

interface AppleDocData {
  identifier?: string;
  title?: string;
  deprecated?: boolean;
  deprecationSummary?: unknown[];
  metadata?: {
    title?: string;
    symbolKind?: string;
    roleHeading?: string;
    platforms?: Array<{ name: string; introducedAt?: string; deprecatedAt?: string; deprecated?: boolean }>;
  };
  seeAlsoSections?: SeeAlsoSection[];
  topicSections?: TopicSection[];
  references?: Record<string, any>;
}

/**
 * 查找相似API
 */
export async function handleFindSimilarApis(
  apiUrl: string,
  searchDepth: string = 'medium',
  filterByCategory?: string,
  includeAlternatives: boolean = true,
): Promise<string> {
  try {
    logger.info(`Finding similar APIs for: ${apiUrl}`);

    const jsonApiUrl = convertToJsonApiUrl(apiUrl);

    // Check if conversion failed
    if (!jsonApiUrl) {
      throw new Error('Invalid Apple Developer Documentation URL');
    }

    const response = await httpClient.getJson<any>(jsonApiUrl);

    // Handle response structure - check if data is wrapped
    let data: AppleDocData;
    let references: Record<string, any> | undefined;

    if (response.data) {
      // Response has a data property, extract it
      data = response.data;
      references = response.references || data.references;
    } else {
      // Response is the data itself
      data = response;
      references = data.references;
    }

    // 收集相似API
    const similarApis: SimilarAPI[] = [];

    // 1. 从"另请参阅"部分收集
    if (data.seeAlsoSections) {
      const seeAlsoApis = extractSeeAlsoApis(data.seeAlsoSections, references, filterByCategory);
      similarApis.push(...seeAlsoApis);
    }

    // 2. 从主题部分收集（medium 和 deep 模式）
    if (searchDepth === 'medium' || searchDepth === 'deep') {
      if (data.topicSections && includeAlternatives) {
        const topicApis = extractTopicApis(data.topicSections, references, filterByCategory);
        similarApis.push(...topicApis);
      }
    }

    // 3. 深度搜索相关API（deep 模式）
    if (searchDepth === 'deep') {
      const deepApis = await extractDeepRelatedApis(similarApis.slice(0, PROCESSING_LIMITS.MAX_SIMILAR_APIS_FOR_DEEP_SEARCH)); // 限制前3个
      similarApis.push(...deepApis);
    }

    // 去重（保留最强的来源）
    const uniqueApis = deduplicateApis(similarApis);

    // 按来源排序；来源 API 已废弃时，非废弃候选项优先（稳定排序）
    uniqueApis.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
    if (isSourceDeprecated(data)) {
      uniqueApis.sort((a, b) => Number(a.deprecated) - Number(b.deprecated));
    }

    // 限制结果数量
    const maxResults = SEARCH_DEPTH_LIMITS[searchDepth as keyof typeof SEARCH_DEPTH_LIMITS] || SEARCH_DEPTH_LIMITS.medium;
    const limitedApis = uniqueApis.slice(0, maxResults);

    // Get the title from data
    const title = data.title || data.metadata?.title || data.identifier?.split('/').pop() || 'API';

    return formatSimilarApis(apiUrl, limitedApis, title, data, references);

  } catch (error) {
    if (describeError(error).includes('Invalid Apple Developer Documentation URL')) {
      throw error;
    }
    throw new Error(describeToolError('find_similar_apis', error));
  }
}

/**
 * 从"另请参阅"部分提取API
 */
function extractSeeAlsoApis(
  seeAlsoSections: SeeAlsoSection[],
  references?: Record<string, any>,
  filterByCategory?: string,
): SimilarAPI[] {
  const apis: SimilarAPI[] = [];

  for (const section of seeAlsoSections) {
    // 过滤分类
    if (filterByCategory && !section.title.toLowerCase().includes(filterByCategory.toLowerCase())) {
      continue;
    }

    for (const identifier of section.identifiers) {
      const api = createSimilarApi(
        identifier,
        section.title,
        'See Also',
        references,
      );
      if (api) {
        apis.push(api);
      }
    }
  }

  return apis;
}

/**
 * 从主题部分提取API
 */
function extractTopicApis(
  topicSections: TopicSection[],
  references?: Record<string, any>,
  filterByCategory?: string,
): SimilarAPI[] {
  const apis: SimilarAPI[] = [];

  for (const section of topicSections) {
    // 过滤分类
    if (filterByCategory && !section.title.toLowerCase().includes(filterByCategory.toLowerCase())) {
      continue;
    }

    // 限制每个主题的API数量
    const limitedIdentifiers = section.identifiers.slice(0, PROCESSING_LIMITS.MAX_TOPIC_IDENTIFIERS);

    for (const identifier of limitedIdentifiers) {
      const api = createSimilarApi(
        identifier,
        section.title,
        'Topic Group',
        references,
      );
      if (api) {
        apis.push(api);
      }
    }
  }

  return apis;
}

/**
 * 深度搜索相关API
 */
async function extractDeepRelatedApis(seedApis: SimilarAPI[]): Promise<SimilarAPI[]> {
  const deepApis: SimilarAPI[] = [];

  for (const seedApi of seedApis) {
    try {
      const jsonApiUrl = convertToJsonApiUrl(seedApi.url);

      if (!jsonApiUrl) {
        logger.warn(`Failed to convert URL: ${seedApi.url}`);
        continue;
      }

      const response = await httpClient.getJson<any>(jsonApiUrl);

      // Handle response structure
      let data: AppleDocData;
      let references: Record<string, any> | undefined;

      if (response.data) {
        data = response.data;
        references = response.references || data.references;
      } else {
        data = response;
        references = data.references;
      }

      // 只从"另请参阅"部分获取，避免过度扩展
      if (data.seeAlsoSections) {
        const relatedApis = extractSeeAlsoApis(data.seeAlsoSections, references);
        // 记录真实来源（通过哪个 API 发现），不再使用伪造的分数
        relatedApis.forEach(api => {
          api.source = 'Deep Related';
          api.category = `${api.category} via ${seedApi.title}`;
        });
        deepApis.push(...relatedApis);
      }
    } catch (error) {
      logger.error(`Failed to fetch deep related API ${seedApi.url}:`, error);
    }
  }

  return deepApis;
}

/**
 * 创建相似API对象
 */
function createSimilarApi(
  identifier: string,
  category: string,
  source: SimilarSource,
  references?: Record<string, any>,
): SimilarAPI | null {
  if (references?.[identifier]) {
    const ref = references[identifier];
    return {
      title: ref.title || 'Unknown',
      url: ref.url ? `https://developer.apple.com${ref.url}` : '#',
      identifier,
      abstract: ref.abstract ? ref.abstract.map((a: any) => a.text || '').join(' ').trim() : undefined,
      category,
      source,
      symbolKind: ref.kind || ref.symbolKind,
      platforms: ref.platforms ? ref.platforms.map((p: any) => p.name) : undefined,
      deprecated: ref.deprecated === true,
    };
  }

  // 如果references中没有，尝试从标识符解析
  if (identifier.startsWith('doc://')) {
    const parts = identifier.split('/');
    const apiName = parts[parts.length - 1] || 'Unknown';
    const pathPart = identifier.replace(/^doc:\/\/[^\/]+\/documentation\//, '');

    return {
      title: apiName,
      url: `https://developer.apple.com/documentation/${pathPart}`,
      identifier,
      category,
      source,
      deprecated: false,
    };
  }

  return null;
}

/**
 * 去重（保留来源优先级最高的记录）
 */
function deduplicateApis(apis: SimilarAPI[]): SimilarAPI[] {
  const apiMap = new Map<string, SimilarAPI>();

  for (const api of apis) {
    const existing = apiMap.get(api.identifier);
    if (!existing || SOURCE_ORDER[api.source] < SOURCE_ORDER[existing.source]) {
      apiMap.set(api.identifier, api);
    }
  }

  return Array.from(apiMap.values());
}

/**
 * 判断来源 API 自身是否已废弃（Apple 用 deprecatedAt 表示）。
 */
function isSourceDeprecated(data: AppleDocData): boolean {
  return Boolean(
    data.deprecated === true ||
    (Array.isArray(data.deprecationSummary) && data.deprecationSummary.length > 0) ||
    data.metadata?.platforms?.some(platform => Boolean(platform.deprecatedAt || platform.deprecated)),
  );
}

/**
 * 格式化相似API结果
 */
function formatSimilarApis(
  originalUrl: string,
  similarApis: SimilarAPI[],
  originalApiName?: string,
  originalData?: AppleDocData,
  references?: Record<string, any>,
): string {
  const apiName = originalApiName || new URL(originalUrl).pathname.split('/').pop() || 'API';
  let content = `# Similar APIs to ${apiName}\n\n`;

  if (similarApis.length === 0) {
    content += 'No similar APIs found';
    return content;
  }

  // Add metadata about the original API if available
  if (originalData?.metadata) {
    const roleHeading = originalData.metadata.roleHeading || '';
    const platforms = originalData.metadata.platforms?.map(p => `${p.name} ${p.introducedAt || ''}+`).join(', ') || '';
    if (roleHeading || platforms) {
      content += `${roleHeading}${platforms ? ' · ' + platforms : ''}\n\n`;
    }
  }

  content += `**Source:** [${originalUrl}](${originalUrl})\n\n`;

  // 来源已废弃时，展示 Apple 提供的迁移说明
  const migration = originalData && isSourceDeprecated(originalData)
    ? renderDeprecationSummary(originalData.deprecationSummary, references)
    : undefined;
  if (migration) {
    content += `> **Migration:** ${migration}\n\n`;
  }

  content += `**Found ${similarApis.length} similar APIs:**\n\n`;

  // Group by source + Apple section, preserving discovery order
  const groupedByCategory = new Map<string, SimilarAPI[]>();

  for (const api of similarApis) {
    const key = `${api.source}: ${api.category}`;
    if (!groupedByCategory.has(key)) {
      groupedByCategory.set(key, []);
    }
    groupedByCategory.get(key)!.push(api);
  }

  for (const [categoryKey, apis] of groupedByCategory) {
    content += `## ${categoryKey}\n\n`;

    for (const api of apis) {
      content += formatSingleSimilarApi(api);
    }
  }

  // 用真实的来源统计代替伪造的相似度分析
  const sourceCounts = new Map<SimilarSource, number>();
  for (const api of similarApis) {
    sourceCounts.set(api.source, (sourceCounts.get(api.source) || 0) + 1);
  }
  const sourceSummary = Array.from(sourceCounts.entries())
    .sort((a, b) => SOURCE_ORDER[a[0]] - SOURCE_ORDER[b[0]])
    .map(([source, count]) => `${source} (${count})`)
    .join(', ');
  content += `**Sources:** ${sourceSummary}\n\n`;

  content += `---\n\n*Total: ${similarApis.length} similar APIs found*`;

  return content;
}


/**
 * 格式化单个相似API
 */
function formatSingleSimilarApi(api: SimilarAPI): string {
  let content = `### [${api.title}](${api.url})${api.deprecated ? ' (Deprecated)' : ''}\n`;

  if (api.abstract) {
    content += `${api.abstract}\n\n`;
  }

  // 诚实的来源信息（不再有伪造的 Similarity 分数）
  const metadata = [`Source: ${api.source} (${api.category})`];
  if (api.symbolKind) {
    metadata.push(`Type: ${api.symbolKind}`);
  }

  content += `*${metadata.join(' | ')}*\n\n`;

  // 添加平台信息
  if (api.platforms && api.platforms.length > 0) {
    content += `**Platforms:** ${api.platforms.join(', ')}\n\n`;
  }

  return content;
}

/**
 * 将 Apple 的 deprecationSummary 渲染为一行纯文本（引用解析为名称）。
 */
function renderDeprecationSummary(
  summary: unknown[] | undefined,
  references?: Record<string, any>,
): string | undefined {
  if (!Array.isArray(summary)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of summary) {
    const paragraph = block as { inlineContent?: unknown[]; text?: string };
    if (Array.isArray(paragraph.inlineContent)) {
      parts.push(paragraph.inlineContent.map(node => renderInlineNode(node, references)).join(''));
    } else if (typeof paragraph.text === 'string') {
      parts.push(paragraph.text);
    }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

function renderInlineNode(node: unknown, references?: Record<string, any>): string {
  const inline = node as { type?: string; text?: string; identifier?: string };
  if (inline.type === 'reference' && inline.identifier) {
    const refTitle = references?.[inline.identifier]?.title;
    if (typeof refTitle === 'string' && refTitle.length > 0) {
      return refTitle;
    }
    const segments = inline.identifier.split('/');
    return segments[segments.length - 1] || '';
  }
  return typeof inline.text === 'string' ? inline.text : '';
}

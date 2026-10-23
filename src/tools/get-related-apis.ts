import { convertToJsonApiUrl } from '../utils/url-converter.js';
import { httpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { PROCESSING_LIMITS } from '../utils/constants.js';
import { describeToolError } from '../utils/error-handler.js';

/**
 * Global cap for related API results. The tool reports the true total and how
 * many items are actually shown, instead of silently truncating.
 */
const GLOBAL_RELATED_APIS_CAP = 60;

/**
 * Topic membership items are "first N identifiers of a topic section" filler,
 * so they are capped harder than Apple-recommended relationships.
 */
const TOPIC_FILLER_CAP = 30;

/**
 * 关联API信息接口
 */
interface RelatedAPI {
  title: string;
  url: string;
  identifier: string;
  type: string;
  relationship: string;
  category: 'recommended' | 'topic';
  abstract?: string;
}

interface RelationshipSection {
  type: string;
  title: string;
  identifiers: string[];
}

interface SeeAlsoSection {
  title: string;
  identifiers: string[];
}

interface AppleDocData {
  relationshipsSections?: RelationshipSection[];
  seeAlsoSections?: SeeAlsoSection[];
  references?: Record<string, any>;
  topicSections?: Array<{
    title: string;
    identifiers: string[];
  }>;
}

/**
 * 获取相关API
 */
export async function handleGetRelatedApis(
  apiUrl: string,
  includeInherited: boolean = true,
  includeConformance: boolean = true,
  includeSeeAlso: boolean = true,
): Promise<string> {
  try {
    logger.info(`Fetching related APIs for: ${apiUrl}`);

    // 将网页URL转换为JSON API URL
    const jsonApiUrl = convertToJsonApiUrl(apiUrl);

    if (!jsonApiUrl) {
      throw new Error('Invalid Apple Developer Documentation URL');
    }

    const data = await httpClient.getJson<AppleDocData>(jsonApiUrl);

    // 收集所有相关API
    const relatedApis: RelatedAPI[] = [];

    // 处理关系部分（继承、一致性等）
    if (data.relationshipsSections) {
      for (const section of data.relationshipsSections) {
        const shouldInclude =
          (includeInherited && (section.type === 'inheritsFrom' || section.type === 'inheritedBy')) ||
          (includeConformance && (section.type === 'conformsTo' || section.type === 'conformingTypes'));

        if (shouldInclude && section.identifiers) {
          for (const identifier of section.identifiers) {
            const api = extractApiFromIdentifier(
              identifier,
              section.title,
              'recommended',
              data.references,
            );
            if (api) {
              relatedApis.push(api);
            }
          }
        }
      }
    }

    // 处理"另请参阅"部分
    if (includeSeeAlso && data.seeAlsoSections) {
      for (const section of data.seeAlsoSections) {
        if (section.identifiers) {
          for (const identifier of section.identifiers) {
            const api = extractApiFromIdentifier(
              identifier,
              `See Also: ${section.title}`,
              'recommended',
              data.references,
            );
            if (api) {
              relatedApis.push(api);
            }
          }
        }
      }
    }

    // 处理主题部分的相关API（Apple 未排序的 topic 成员，属于补充信息）
    if (data.topicSections) {
      for (const section of data.topicSections) {
        if (section.identifiers && section.identifiers.length > 0) {
          // 只取前几个，避免过多
          const limitedIdentifiers = section.identifiers.slice(0, PROCESSING_LIMITS.MAX_RELATED_APIS_PER_SECTION);
          for (const identifier of limitedIdentifiers) {
            const api = extractApiFromIdentifier(
              identifier,
              section.title,
              'topic',
              data.references,
            );
            if (api) {
              relatedApis.push(api);
            }
          }
        }
      }
    }

    // 去重
    const uniqueApis = deduplicateApis(relatedApis);

    // 格式化输出
    return formatRelatedApis(apiUrl, uniqueApis);

  } catch (error) {
    return `Error: ${describeToolError('get_related_apis', error)}`;
  }
}



/**
 * 从标识符提取API信息
 */
function extractApiFromIdentifier(
  identifier: string,
  relationship: string,
  category: 'recommended' | 'topic',
  references?: Record<string, any>,
): RelatedAPI | null {
  // 先从references中查找
  if (references?.[identifier]) {
    const ref = references[identifier];
    return {
      title: ref.title || 'Unknown',
      url: ref.url ? `https://developer.apple.com${ref.url}` : '#',
      identifier,
      type: ref.kind || ref.type || 'unknown',
      relationship,
      category,
      abstract: ref.abstract ? ref.abstract.map((a: any) => a.text || '').join(' ').trim() : undefined,
    };
  }

  // 如果references中没有，尝试解析标识符
  if (identifier.startsWith('doc://')) {
    const parts = identifier.split('/');
    const apiName = parts[parts.length - 1] || 'Unknown';
    const pathPart = identifier.replace(/^doc:\/\/[^\/]+\/documentation\//, '');

    return {
      title: apiName,
      url: `https://developer.apple.com/documentation/${pathPart}`,
      identifier,
      type: 'symbol',
      relationship,
      category,
    };
  }

  return null;
}

/**
 * 去重API列表
 */
function deduplicateApis(apis: RelatedAPI[]): RelatedAPI[] {
  const seen = new Set<string>();
  return apis.filter(api => {
    if (seen.has(api.identifier)) {
      return false;
    }
    seen.add(api.identifier);
    return true;
  });
}

/**
 * 格式化相关API输出
 */
function formatRelatedApis(originalUrl: string, relatedApis: RelatedAPI[]): string {
  if (relatedApis.length === 0) {
    return `No related APIs found for: ${originalUrl}`;
  }

  // Apple 推荐的关系优先；topic 成员是未排序的补充信息
  const recommended = relatedApis.filter(api => api.category === 'recommended');
  const topic = relatedApis.filter(api => api.category === 'topic');

  const selectedRecommended = recommended.slice(0, GLOBAL_RELATED_APIS_CAP);
  const fillerSlots = Math.max(0, GLOBAL_RELATED_APIS_CAP - selectedRecommended.length);
  const selectedTopic = topic.slice(0, Math.min(TOPIC_FILLER_CAP, fillerSlots));
  const selected = [...selectedRecommended, ...selectedTopic];

  const totalFound = relatedApis.length;
  const shown = selected.length;

  const apiName = new URL(originalUrl).pathname.split('/').pop() || 'API';
  let content = `# Related APIs for ${apiName}\n\n`;
  content += `**Source:** [${originalUrl}](${originalUrl})\n\n`;
  content += `**Found ${totalFound} related APIs (showing ${shown})**\n\n`;

  if (selectedRecommended.length > 0) {
    content += '## Apple recommends\n\n';
    content += formatRelationshipGroups(selectedRecommended);
  }

  if (selectedTopic.length > 0) {
    content += '## Topic membership\n\n';
    content += formatRelationshipGroups(selectedTopic);
  }

  content += `---\n\n*Showing ${shown} of ${totalFound} related APIs*`;

  return content;
}

/**
 * 按关系/主题分组渲染
 */
function formatRelationshipGroups(apis: RelatedAPI[]): string {
  const groups = new Map<string, RelatedAPI[]>();

  for (const api of apis) {
    const existing = groups.get(api.relationship);
    if (existing) {
      existing.push(api);
    } else {
      groups.set(api.relationship, [api]);
    }
  }

  let content = '';
  for (const [relationship, groupApis] of groups) {
    content += `### ${relationship}\n\n`;

    for (const api of groupApis) {
      content += `#### [${api.title}](${api.url})`;
      // Type 只在不是通用 "symbol" 时内联展示，避免重复噪音
      if (api.type && api.type !== 'symbol') {
        content += ` — *${api.type}*`;
      }
      content += '\n';

      if (api.abstract) {
        content += `${api.abstract}\n`;
      }

      content += '\n';
    }
  }

  return content;
}

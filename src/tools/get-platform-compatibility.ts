import { convertToJsonApiUrl } from '../utils/url-converter.js';
import { httpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { PROCESSING_LIMITS } from '../utils/constants.js';
import { describeToolError } from '../utils/error-handler.js';

/**
 * 平台兼容性信息接口
 */
interface PlatformInfo {
  name: string;
  introducedAt?: string;
  deprecatedAt?: string;
  obsoletedAt?: string;
  beta?: boolean;
  deprecated?: boolean;
  unavailable?: boolean;
  message?: string;
}

interface CompatibilityAnalysis {
  apiName: string;
  apiUrl: string;
  platforms: PlatformInfo[];
  /** Apple's migration sentence, when available. */
  deprecationSummary?: string;
}

interface AppleDocData {
  metadata?: {
    title?: string;
    platforms?: PlatformInfo[];
    symbolKind?: string;
    role?: string;
  };
  deprecationSummary?: unknown[];
  topicSections?: Array<{
    title: string;
    identifiers: string[];
  }>;
  references?: Record<string, any>;
}

/**
 * 获取平台兼容性分析
 */
export async function handleGetPlatformCompatibility(
  apiUrl: string,
  compareMode: string = 'single',
  includeRelated: boolean = false,
): Promise<string> {
  try {
    logger.info(`Analyzing platform compatibility for: ${apiUrl}`);

    if (compareMode === 'framework') {
      return await analyzeFrameworkCompatibility(apiUrl, includeRelated);
    } else {
      return await analyzeSingleApiCompatibility(apiUrl, includeRelated);
    }

  } catch (error) {
    return `Error: ${describeToolError('get_platform_compatibility', error)}`;
  }
}

/**
 * 分析单个API的平台兼容性
 */
async function analyzeSingleApiCompatibility(
  apiUrl: string,
  includeRelated: boolean,
): Promise<string> {
  const jsonApiUrl = convertToJsonApiUrl(apiUrl);

  if (!jsonApiUrl) {
    throw new Error('Invalid Apple Developer Documentation URL');
  }

  const data = await httpClient.getJson<AppleDocData>(jsonApiUrl);

  if (!data.metadata?.platforms) {
    return `No platform information available for: ${apiUrl}`;
  }

  const analysis = analyzeCompatibility(
    data.metadata.title || 'Unknown API',
    apiUrl,
    data.metadata.platforms,
    renderDeprecationSummary(data.deprecationSummary, data.references),
  );

  let result = formatCompatibilityAnalysis(analysis, false);

  // 如果需要包含相关API的兼容性信息
  if (includeRelated && data.topicSections) {
    const relatedAnalyses = await analyzeRelatedCompatibility(data, 3); // 限制3个相关API
    if (relatedAnalyses.length > 0) {
      result += '\n\n## Related APIs Compatibility\n\n';
      for (const relatedAnalysis of relatedAnalyses) {
        result += formatCompatibilityAnalysis(relatedAnalysis, true) + '\n';
      }
    }
  }

  return result;
}

/**
 * 框架级对比目前未实现。明确告知调用方（而不是伪装成框架分析），
 * 然后回退到单 API 兼容性。
 */
async function analyzeFrameworkCompatibility(
  frameworkUrl: string,
  includeRelated: boolean,
): Promise<string> {
  const note = '> **Note:** compareMode "framework" is not supported. Showing single-API compatibility instead.\n\n';
  return note + await analyzeSingleApiCompatibility(frameworkUrl, includeRelated);
}

/**
 * 分析相关API的兼容性
 */
async function analyzeRelatedCompatibility(
  data: AppleDocData,
  maxRelated: number = 3,
): Promise<CompatibilityAnalysis[]> {
  const analyses: CompatibilityAnalysis[] = [];

  if (!data.topicSections || !data.references) {
    return analyses;
  }

  let count = 0;
  for (const section of data.topicSections) {
    if (count >= maxRelated) {
      break;
    }

    for (const identifier of section.identifiers.slice(0, PROCESSING_LIMITS.MAX_PLATFORM_COMPATIBILITY_ITEMS)) { // 每个section最多2个
      if (count >= maxRelated) {
        break;
      }

      const ref = data.references[identifier];
      if (ref?.url) {
        try {
          const relatedUrl = `https://developer.apple.com${ref.url}`;
          const relatedJsonUrl = convertToJsonApiUrl(relatedUrl);

          if (!relatedJsonUrl) {
            logger.warn(`Failed to convert URL: ${relatedUrl}`);
            continue;
          }

          const relatedData = await httpClient.getJson<AppleDocData>(relatedJsonUrl);
          if (relatedData.metadata?.platforms) {
            const analysis = analyzeCompatibility(
              ref.title || 'Unknown',
              relatedUrl,
              relatedData.metadata.platforms,
              renderDeprecationSummary(relatedData.deprecationSummary, relatedData.references),
            );
            analyses.push(analysis);
            count++;
          }
        } catch (error) {
          // 忽略单个相关API的错误
          logger.error(`Failed to fetch related API ${identifier}:`, error);
        }
      }
    }
  }

  return analyses;
}

/**
 * 分析兼容性数据
 */
function analyzeCompatibility(
  apiName: string,
  apiUrl: string,
  platforms: PlatformInfo[],
  deprecationSummary?: string,
): CompatibilityAnalysis {
  return {
    apiName,
    apiUrl,
    platforms,
    deprecationSummary,
  };
}



/**
 * 格式化兼容性分析结果
 */
function formatCompatibilityAnalysis(
  analysis: CompatibilityAnalysis,
  isRelated: boolean = false,
): string {
  const prefix = isRelated ? '### ' : '# ';
  let content = `${prefix}Platform Compatibility: [${analysis.apiName}](${analysis.apiUrl})\n\n`;

  content += '| Platform | Introduced | Deprecated | Notes |\n';
  content += '|---|---|---|---|\n';

  for (const platform of analysis.platforms) {
    const introduced = platform.introducedAt || '-';
    const deprecated = platform.deprecatedAt || (platform.deprecated ? 'Yes' : '-');
    content += `| ${platform.name} | ${introduced} | ${deprecated} | ${formatPlatformNotes(platform)} |\n`;
  }

  const deprecation = getDeprecationInfo(analysis.platforms, analysis.deprecationSummary);
  if (deprecation.deprecated) {
    content += `\n⚠️ **Deprecated**${deprecation.summary ? ` — ${deprecation.summary}` : ''}\n`;
  }

  return content;
}

/**
 * 平台备注：只保留有意义的状态，避免重复版本信息。
 */
function formatPlatformNotes(platform: PlatformInfo): string {
  const notes: string[] = [];
  if (platform.unavailable) {
    notes.push('Unavailable');
  }
  if (platform.beta) {
    notes.push('Beta');
  }
  if (platform.obsoletedAt) {
    notes.push(`Obsoleted ${platform.obsoletedAt}`);
  }
  return notes.length > 0 ? notes.join(', ') : '-';
}

/**
 * 通过 deprecatedAt（Apple 实际使用的字段）判断废弃状态，并取迁移说明。
 */
function getDeprecationInfo(
  platforms: PlatformInfo[],
  summary?: string,
): { deprecated: boolean; summary?: string } {
  const deprecated = platforms.some(platform =>
    Boolean(platform.deprecatedAt || platform.deprecated || platform.obsoletedAt),
  );
  const platformMessage = platforms.map(platform => platform.message).find(message => Boolean(message));
  return { deprecated, summary: summary || platformMessage };
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

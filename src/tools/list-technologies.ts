import { technologiesCache, generateUrlCacheKey } from '../utils/cache.js';
import { APPLE_URLS, API_LIMITS } from '../utils/constants.js';
import { httpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { describeError } from '../utils/error-handler.js';

/**
 * 技术信息接口
 */
interface Technology {
  title: string;
  identifier: string;
  tags: string[];
  languages: string[];
  url?: string;
  destination?: {
    identifier: string;
  };
}

interface TechnologyGroup {
  name: string;
  technologies: Technology[];
}

interface TechnologiesData {
  sections: Array<{
    kind: string;
    groups: TechnologyGroup[];
  }>;
}

interface TechnologyFilterResult {
  groups: TechnologyGroup[];
  /** Total number of technologies matching the filters, before the per-category limit. */
  total: number;
}

/**
 * 获取技术列表
 */
export async function handleListTechnologies(
  category?: string,
  language?: string,
  includeBeta: boolean = true,
  limit: number = API_LIMITS.DEFAULT_TECHNOLOGIES_LIMIT,
): Promise<string> {
  try {
    logger.info('Fetching technologies list...');

    // Generate cache key
    const cacheKey = generateUrlCacheKey('technologies', { category, language, includeBeta, limit });

    // Try to get from cache first
    const cachedResult = technologiesCache.get<string>(cacheKey);
    if (cachedResult) {
      logger.debug('Technologies cache hit');
      return cachedResult;
    }

    // 获取技术列表
    const data = await httpClient.getJson<TechnologiesData>(APPLE_URLS.TECHNOLOGIES_JSON);

    // 解析技术列表
    const technologies = parseTechnologies(data);

    // 应用过滤器
    const filtered = applyTechnologyFilters(technologies, {
      category,
      language,
      includeBeta,
      limit,
    });

    // 格式化输出
    const result = formatTechnologiesList(filtered.groups, filtered.total);

    // Cache the result
    technologiesCache.set(cacheKey, result);

    return result;

  } catch (error) {
    const errorMessage = describeError(error);
    return `Error: Failed to list technologies: ${errorMessage}`;
  }
}

/**
 * 解析技术数据
 */
function parseTechnologies(data: TechnologiesData): TechnologyGroup[] {
  const groups: TechnologyGroup[] = [];

  if (data.sections) {
    data.sections.forEach(section => {
      if (section.kind === 'technologies' && section.groups) {
        section.groups.forEach(group => {
          if (group.technologies && Array.isArray(group.technologies)) {
            const technologies: Technology[] = group.technologies.map(tech => ({
              title: tech.title || '',
              identifier: tech.destination?.identifier || tech.identifier || '',
              tags: tech.tags || [],
              languages: tech.languages || [],
              url: tech.destination?.identifier
                ? tech.destination.identifier.replace('doc://com.apple.documentation/documentation/', 'https://developer.apple.com/documentation/')
                : undefined,
            }));

            groups.push({
              name: group.name,
              technologies,
            });
          }
        });
      }
    });
  }

  return groups;
}

/**
 * 应用过滤器
 *
 * `limit` 按分类（group）生效，而不是全局生效；同时返回过滤后的真实总数，
 * 以便输出 "Total: N (showing M of N)"。
 */
function applyTechnologyFilters(
  groups: TechnologyGroup[],
  filters: {
    category?: string;
    language?: string;
    includeBeta?: boolean;
    limit?: number;
  },
): TechnologyFilterResult {
  const category = filters.category?.toLowerCase();
  const limit = filters.limit !== undefined && filters.limit >= 0
    ? filters.limit
    : API_LIMITS.DEFAULT_TECHNOLOGIES_LIMIT;

  const filteredGroups: TechnologyGroup[] = [];
  let total = 0;

  for (const group of groups) {
    const groupNameMatches = category !== undefined && group.name.toLowerCase().includes(category);

    const matchingTechnologies = group.technologies.filter(tech => {
      // Beta 过滤
      if (!filters.includeBeta && tech.tags.includes('Beta')) {
        return false;
      }

      // 语言过滤
      if (filters.language && !tech.languages.includes(filters.language)) {
        return false;
      }

      // 分类过滤：匹配分组名称，或技术名称/标签
      if (category && !groupNameMatches && !technologyMatchesCategory(tech, category)) {
        return false;
      }

      return true;
    });

    if (matchingTechnologies.length === 0) {
      continue;
    }

    total += matchingTechnologies.length;

    // limit 按分类生效（limit 为 0 时不展示，但仍报告真实总数）
    if (limit === 0) {
      continue;
    }

    filteredGroups.push({
      ...group,
      technologies: matchingTechnologies.slice(0, limit),
    });
  }

  return { groups: filteredGroups, total };
}

/**
 * 技术名称、标识符或标签是否匹配分类关键字（大小写不敏感）。
 */
function technologyMatchesCategory(tech: Technology, category: string): boolean {
  return tech.title.toLowerCase().includes(category) ||
    tech.identifier.toLowerCase().includes(category) ||
    tech.tags.some(tag => tag.toLowerCase().includes(category));
}

function pluralizeTechnologies(count: number): string {
  return count === 1 ? 'technology' : 'technologies';
}

/**
 * 格式化技术列表
 */
function formatTechnologiesList(groups: TechnologyGroup[], total: number): string {
  if (groups.length === 0) {
    if (total === 0) {
      return 'No technologies found matching the specified criteria.';
    }
    return `*Total: ${total} ${pluralizeTechnologies(total)} (showing 0 of ${total})*`;
  }

  let content = '# Apple Developer Technologies\n\n';

  // 诚实统计：真实总数 + 实际展示数量
  const shownTechs = groups.reduce((sum, group) => sum + group.technologies.length, 0);
  const betaTechs = groups.reduce((sum, group) =>
    sum + group.technologies.filter(tech => tech.tags.includes('Beta')).length, 0);

  content += `*Total: ${total} ${pluralizeTechnologies(total)} (showing ${shownTechs} of ${total}`;
  if (betaTechs > 0) {
    content += `, ${betaTechs} in beta`;
  }
  content += ')*\n\n';

  // 按分类显示
  groups.forEach(group => {
    content += `## ${group.name}\n\n`;

    group.technologies.forEach(tech => {
      // Create title with status information
      const isBeta = tech.tags.includes('Beta');
      const titleWithStatus = isBeta ? `${tech.title} (Beta)` : tech.title;

      content += `### [${titleWithStatus}](${tech.url || '#'})\n`;

      // Build metadata array
      const metadata = [];

      // Add languages
      if (tech.languages.length > 0) {
        metadata.push(`Languages: ${tech.languages.join(', ')}`);
      }

      // Add categories (excluding Beta since it's in title)
      const nonBetaTags = tech.tags.filter(tag => tag !== 'Beta');
      if (nonBetaTags.length > 0) {
        metadata.push(`Categories: ${nonBetaTags.join(', ')}`);
      }

      // Add metadata line if any
      if (metadata.length > 0) {
        content += `*${metadata.join(' | ')}*\n`;
      }

      content += '\n';
    });
  });

  content += '\n---\n\n[View all technologies on Apple Developer](https://developer.apple.com/documentation/technologies)';

  return content;
}

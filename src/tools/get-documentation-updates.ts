import { updatesCache, generateUrlCacheKey } from '../utils/cache.js';
import { APPLE_URLS } from '../utils/constants.js';
import { httpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { describeError } from '../utils/error-handler.js';

/**
 * Interface for Updates data
 */
interface UpdatesData {
  topicSections: Array<{
    title: string;
    identifiers: string[];
    anchor: string;
  }>;
  references: Record<string, {
    type: string;
    title: string;
    url: string;
    abstract?: Array<{ text: string; type: string }>;
    images?: Array<{ type: string; identifier: string }>;
    kind?: string;
    role?: string;
  }>;
}

/**
 * Interface for Updates Index data
 */
interface UpdatesIndexData {
  interfaceLanguages: {
    swift: UpdatesIndexSection[];
  };
  /**
   * Optional reference map. The live index currently stores only images here,
   * but older snapshots also exposed the update pages themselves, so both
   * shapes are indexed when building the technology → slug lookup.
   */
  references?: Record<string, { title?: string; url?: string }>;
}

interface UpdatesIndexSection {
  path: string;
  title: string;
  type: string;
  beta?: boolean;
  children?: UpdatesIndexSection[];
}

/** Detail mode for `get_documentation_updates` (mirrors the zod schema). */
export type UpdatesDetail = 'auto' | 'index' | 'timeline';

/**
 * Handle get documentation updates
 */
export async function handleGetDocumentationUpdates(
  category: string = 'all',
  technology?: string,
  year?: string,
  searchQuery?: string,
  includeBeta: boolean = true,
  limit: number = 50,
  detail: UpdatesDetail = 'auto',
): Promise<string> {
  try {
    logger.info('Fetching documentation updates...');

    // `auto` is the backwards-compatible default: a technology turns the call
    // into a dated timeline, otherwise the legacy index is returned verbatim.
    const mode: 'index' | 'timeline' = detail === 'auto'
      ? (technology ? 'timeline' : 'index')
      : detail;

    if (mode === 'timeline') {
      return await handleUpdatesTimeline(category, technology, year, searchQuery, includeBeta, limit);
    }

    return await handleUpdatesIndex(category, technology, year, searchQuery, includeBeta, limit);

  } catch (error) {
    const errorMessage = describeError(error);
    logger.error('Error fetching documentation updates:', error);
    return `Error: Failed to fetch documentation updates: ${errorMessage}`;
  }
}

/**
 * Legacy index mode: alphabetical/topic directory of update pages (no dates).
 */
async function handleUpdatesIndex(
  category: string,
  technology: string | undefined,
  year: string | undefined,
  searchQuery: string | undefined,
  includeBeta: boolean,
  limit: number,
): Promise<string> {
  // Generate cache key
  const cacheKey = generateUrlCacheKey('documentation-updates', {
    category,
    technology,
    year,
    searchQuery,
    includeBeta,
    limit,
  });

  // Try to get from cache first
  const cachedResult = updatesCache.get<string>(cacheKey);
  if (cachedResult) {
    logger.debug('Updates cache hit');
    return cachedResult;
  }

  // Fetch both updates data files
  const [updatesData, updatesIndex] = await Promise.all([
    httpClient.getJson<UpdatesData>(APPLE_URLS.UPDATES_JSON),
    httpClient.getJson<UpdatesIndexData>(APPLE_URLS.UPDATES_INDEX_JSON),
  ]);

  // Parse and filter updates
  const updates = parseUpdates(updatesData, updatesIndex);
  const filteredUpdates = applyUpdatesFilters(updates, {
    category,
    technology,
    year,
    searchQuery,
    includeBeta,
    limit,
  });

  // Format output
  const result = formatUpdatesList(filteredUpdates);

  // Cache the result
  updatesCache.set(cacheKey, result);

  return result;
}

// ---------------------------------------------------------------------------
// Timeline mode — dated "what changed" from /documentation/updates/<slug>.json
// ---------------------------------------------------------------------------

/** Hard ceiling for the whole timeline response. */
export const TIMELINE_MAX_OUTPUT_CHARS = 14000;

/** Per-change text budget (long entries are clipped with an ellipsis). */
export const TIMELINE_MAX_ENTRY_CHARS = 400;

/** Space reserved for the title/abstract/"Showing …" header when budgeting. */
const TIMELINE_HEADER_RESERVE = 600;

const TIMELINE_TRUNCATION_NOTE =
  `\n\n> ⚠️ output truncated: the timeline exceeded ${TIMELINE_MAX_OUTPUT_CHARS} characters. Narrow it with year/searchQuery or a smaller limit.\n`;

/** Inline node (`text`, `codeVoice`, `reference`, `link`, …). */
interface InlineNode {
  type?: string;
  text?: string;
  code?: string;
  identifier?: string;
  title?: string;
  url?: string;
  titleInlineContent?: InlineNode[];
  inlineContent?: InlineNode[];
}

/** A documentation-rendering content block (loosely typed on purpose). */
interface ContentBlock {
  type?: string;
  level?: number;
  text?: string;
  inlineContent?: InlineNode[];
  items?: Array<{ content?: ContentBlock[] }>;
  content?: ContentBlock[];
}

interface TimelineReference {
  title?: string;
  url?: string;
}

interface TimelineDocument {
  metadata?: { title?: string };
  abstract?: InlineNode[];
  primaryContentSections?: Array<{ kind?: string; content?: ContentBlock[] }>;
  references?: Record<string, TimelineReference>;
}

interface TimelineSection {
  title: string;
  year?: string;
  entries: string[];
  subsections: Array<{ title: string; entries: string[] }>;
}

interface ResolvedUpdatesPage {
  slug: string;
  title: string;
}

const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_HEADING_RE = new RegExp(`^(?:${MONTH_NAMES})\\s+(\\d{4})(?:\\b|[,\\u2013\\u2014-].*)$`, 'i');

/** Normalize a technology name/slug for case-, space- and hyphen-insensitive matching. */
function normalizeTechnologyKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Extract the slug from a `/documentation/updates/<slug>` path. */
function slugFromUpdatesPath(path: string): string | undefined {
  const match = path.match(/\/documentation\/updates\/([^/?#]+)/i);
  return match?.[1];
}

/**
 * Build a normalized name → page lookup from the updates index.
 *
 * The live index carries the pages in the `interfaceLanguages.swift` tree;
 * some snapshots expose them as `references` entries with a `url`. Both are
 * indexed, together with slug and title variants ("SwiftUI", "SwiftUI updates").
 */
function buildUpdatesPageLookup(index: UpdatesIndexData | undefined): {
  lookup: Map<string, ResolvedUpdatesPage>;
  titles: string[];
} {
  const lookup = new Map<string, ResolvedUpdatesPage>();
  const canonical = new Map<string, ResolvedUpdatesPage>();

  const register = (title: string | undefined, path: string | undefined): void => {
    if (!path) {
      return;
    }
    const slug = slugFromUpdatesPath(path);
    if (!slug || !title) {
      return;
    }
    const page: ResolvedUpdatesPage = { slug, title: title.trim() };
    canonical.set(slug, page);

    const keys = [
      normalizeTechnologyKey(title),
      normalizeTechnologyKey(title.replace(/\s+updates?$/i, '')),
      normalizeTechnologyKey(slug),
    ];
    for (const key of keys) {
      if (key && !lookup.has(key)) {
        lookup.set(key, page);
      }
    }
  };

  const references = index?.references ?? {};
  for (const reference of Object.values(references)) {
    register(reference.title, reference.url);
  }

  const walk = (sections: UpdatesIndexSection[] | undefined): void => {
    for (const section of sections ?? []) {
      register(section.title, section.path);
      walk(section.children);
    }
  };
  walk(index?.interfaceLanguages?.swift);

  const titles = [...canonical.values()]
    .map(page => page.title)
    .filter((title, position, all) => all.indexOf(title) === position)
    .sort((a, b) => a.localeCompare(b));

  return { lookup, titles };
}

/** Resolve the caller's `technology` to an updates page, or null. */
function resolveUpdatesPage(
  technology: string | undefined,
  lookup: Map<string, ResolvedUpdatesPage>,
): ResolvedUpdatesPage | null {
  if (!technology || !technology.trim()) {
    return null;
  }
  const pathSlug = slugFromUpdatesPath(technology);
  const candidate = pathSlug ?? technology;
  return lookup.get(normalizeTechnologyKey(candidate)) ?? null;
}

/** Render inline content (text/code/reference/link) as markdown. */
function renderInline(nodes: InlineNode[] | undefined, references: Record<string, TimelineReference>): string {
  if (!nodes || nodes.length === 0) {
    return '';
  }
  return nodes.map(node => {
    switch (node.type) {
      case 'text':
        return node.text ?? '';
      case 'codeVoice':
        return node.code ? `\`${node.code}\`` : '';
      case 'reference': {
        const reference = node.identifier ? references[node.identifier] : undefined;
        const label = reference?.title ?? node.title ?? node.identifier ?? '';
        if (!label) {
          return '';
        }
        const url = reference?.url
          ? `${APPLE_URLS.BASE}${reference.url}`
          : (node.url ?? '');
        return url ? `[${label}](${url})` : label;
      }
      case 'link': {
        const label = node.title
          ?? renderInline(node.titleInlineContent, references)
          ?? node.url
          ?? node.identifier
          ?? '';
        const url = node.url ?? node.identifier ?? '';
        return url ? `[${label || url}](${url})` : label;
      }
      case 'emphasis':
        return node.inlineContent ? `*${renderInline(node.inlineContent, references)}*` : '';
      case 'strong':
        return node.inlineContent ? `**${renderInline(node.inlineContent, references)}**` : '';
      case 'image':
        return '';
      default:
        if (node.inlineContent) {
          return renderInline(node.inlineContent, references);
        }
        return node.text ?? '';
    }
  }).join('');
}

/** Normalize rendered inline text: collapse whitespace and clip long changes. */
function normalizeEntryText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= TIMELINE_MAX_ENTRY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, TIMELINE_MAX_ENTRY_CHARS - 1).trimEnd()}…`;
}

/** Pull the human-readable entries out of one content block. */
function extractEntries(
  block: ContentBlock,
  references: Record<string, TimelineReference>,
): string[] {
  const entries: string[] = [];

  const fromBlocks = (blocks: ContentBlock[] | undefined): string => {
    if (!blocks || blocks.length === 0) {
      return '';
    }
    return blocks.map(child => {
      if (child.inlineContent) {
        return renderInline(child.inlineContent, references);
      }
      if (child.content) {
        return fromBlocks(child.content);
      }
      return child.text ?? '';
    }).filter(Boolean).join(' ');
  };

  const add = (text: string): void => {
    const normalized = normalizeEntryText(text);
    if (normalized) {
      entries.push(normalized);
    }
  };

  if (block.type === 'paragraph' || block.type === 'aside') {
    add(block.content ? fromBlocks(block.content) : renderInline(block.inlineContent, references));
    return entries;
  }

  if (block.type === 'unorderedList' || block.type === 'orderedList' || block.type === 'termList') {
    for (const item of block.items ?? []) {
      add(fromBlocks(item.content));
    }
    return entries;
  }

  return entries;
}

/**
 * Parse the dated sections out of an updates document.
 *
 * Month+year headings start a dated section; every other heading inside a
 * dated section is a sub-topic. Content before the first dated heading (the
 * "Overview" preamble) is ignored.
 */
function parseTimelineDocument(doc: TimelineDocument): {
  title: string;
  abstract: string;
  sections: TimelineSection[];
} {
  const references = doc.references ?? {};
  const blocks = (doc.primaryContentSections ?? [])
    .filter(section => !section.kind || section.kind === 'content')
    .flatMap(section => section.content ?? []);

  const sections: TimelineSection[] = [];
  let currentSection: TimelineSection | null = null;
  let currentSubsection: { title: string; entries: string[] } | null = null;

  for (const block of blocks) {
    if (block.type === 'heading') {
      const headingText = (block.text ?? '').trim();
      if (!headingText) {
        continue;
      }
      const dateMatch = headingText.match(DATE_HEADING_RE);
      if (dateMatch) {
        currentSection = {
          title: headingText,
          year: dateMatch[1],
          entries: [],
          subsections: [],
        };
        sections.push(currentSection);
        currentSubsection = null;
        continue;
      }
      if (currentSection) {
        currentSubsection = { title: headingText, entries: [] };
        currentSection.subsections.push(currentSubsection);
      }
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const entries = extractEntries(block, references);
    if (entries.length === 0) {
      continue;
    }
    (currentSubsection ? currentSubsection.entries : currentSection.entries).push(...entries);
  }

  const metadataTitle = doc.metadata?.title?.trim() ?? '';
  return {
    title: metadataTitle,
    abstract: normalizeEntryText(renderInline(doc.abstract, references)),
    sections,
  };
}

/** Keep only entries matching the search query, dropping empty sections. */
function applyTimelineFilters(
  sections: TimelineSection[],
  filters: { year?: string; searchQuery?: string },
): TimelineSection[] {
  const query = filters.searchQuery?.trim().toLowerCase();

  const keepEntry = (entry: string): boolean =>
    !query || entry.toLowerCase().includes(query);

  return sections
    .filter(section => !filters.year || section.year === filters.year)
    .map(section => ({
      ...section,
      entries: section.entries.filter(keepEntry),
      subsections: section.subsections
        .map(subsection => ({
          ...subsection,
          entries: subsection.entries.filter(keepEntry),
        }))
        .filter(subsection => subsection.entries.length > 0),
    }))
    .filter(section => section.entries.length > 0 || section.subsections.length > 0);
}

/** Flatten date sections into a document-ordered list of entry counts. */
function countTimelineEntries(sections: TimelineSection[]): number {
  return sections.reduce(
    (total, section) => total
      + section.entries.length
      + section.subsections.reduce((subTotal, subsection) => subTotal + subsection.entries.length, 0),
    0,
  );
}

/** Format a timeline within the output/entry budgets. */
export function formatUpdatesTimeline(
  sourceTitle: string,
  abstract: string,
  sections: TimelineSection[],
  totalChanges: number,
  limit: number,
): string {
  const displayTitle = /updates?$/i.test(sourceTitle)
    ? sourceTitle.replace(/\s+updates?$/i, '') + ' Documentation Updates'
    : `${sourceTitle} Documentation Updates`;

  const capacity = TIMELINE_MAX_OUTPUT_CHARS - TIMELINE_TRUNCATION_NOTE.length - TIMELINE_HEADER_RESERVE;
  let body = '';
  let renderedChanges = 0;
  let renderedSections = 0;
  let truncated = false;

  const push = (chunk: string): boolean => {
    if (body.length + chunk.length > capacity) {
      truncated = true;
      return false;
    }
    body += chunk;
    return true;
  };

  // Track the start of the section/subsection currently being written so a
  // budget cut that lands before any entry can roll back the dangling heading.
  let sectionStart = -1;
  let sectionCounted = false;
  let subsectionStart = -1;
  let subsectionCounted = false;

  const noteEntry = (): void => {
    renderedChanges++;
    if (!sectionCounted) {
      renderedSections++;
      sectionCounted = true;
    }
  };

  outer:
  for (const section of sections) {
    if (renderedChanges >= limit) {
      break;
    }

    sectionStart = body.length;
    sectionCounted = false;
    subsectionStart = -1;
    subsectionCounted = false;

    if (!push(`## ${section.title}\n\n`)) {
      sectionStart = -1;
      break;
    }

    for (const entry of section.entries) {
      if (renderedChanges >= limit) {
        break outer;
      }
      if (!push(`- ${entry}\n\n`)) {
        break outer;
      }
      noteEntry();
    }

    for (const subsection of section.subsections) {
      if (renderedChanges >= limit) {
        break outer;
      }
      subsectionStart = body.length;
      subsectionCounted = false;
      if (!push(`### ${subsection.title}\n\n`)) {
        subsectionStart = -1;
        break outer;
      }
      for (const entry of subsection.entries) {
        if (renderedChanges >= limit) {
          break outer;
        }
        if (!push(`- ${entry}\n\n`)) {
          break outer;
        }
        subsectionCounted = true;
        noteEntry();
      }
      if (!subsectionCounted) {
        body = body.slice(0, subsectionStart);
        subsectionStart = -1;
      }
    }
  }

  // Drop a section heading that ended up with no entries (budget cut).
  if (sectionStart >= 0 && !sectionCounted) {
    body = body.slice(0, sectionStart);
    truncated = true;
  }
  // Drop a trailing subsection heading that ended up with no entries.
  if (subsectionStart >= 0 && !subsectionCounted) {
    body = body.slice(0, Math.min(subsectionStart, body.length));
    truncated = true;
  }

  const header = `# ${displayTitle}\n\n`
    + `${abstract ? `${abstract}\n\n` : ''}`
    + `Showing ${renderedChanges} of ${totalChanges} changes · sections: ${renderedSections}\n\n`;

  let output = `${header}${body.trimEnd()}`;
  if (truncated) {
    output += TIMELINE_TRUNCATION_NOTE;
  }

  if (output.length > TIMELINE_MAX_OUTPUT_CHARS) {
    const keep = TIMELINE_MAX_OUTPUT_CHARS - TIMELINE_TRUNCATION_NOTE.length - 1;
    output = `${output.slice(0, keep).trimEnd()}…${TIMELINE_TRUNCATION_NOTE}`;
  }

  return output;
}

/**
 * Timeline mode: dated changes for a single technology.
 *
 * Resolves `technology` against the updates index, fetches
 * `/documentation/updates/<slug>.json` and renders the dated sections.
 */
async function handleUpdatesTimeline(
  category: string,
  technology: string | undefined,
  year: string | undefined,
  searchQuery: string | undefined,
  includeBeta: boolean,
  limit: number,
): Promise<string> {
  const updatesIndex = await httpClient.getJson<UpdatesIndexData>(APPLE_URLS.UPDATES_INDEX_JSON);
  const { lookup, titles } = buildUpdatesPageLookup(updatesIndex);
  const page = resolveUpdatesPage(technology, lookup);

  if (!page) {
    if (!technology || !technology.trim()) {
      return 'Error: detail="timeline" requires a technology (e.g. "SwiftUI", "UIKit", "AppKit"). '
        + 'Omit technology for the legacy index, or use detail="auto".';
    }
    const examples = titles.slice(0, 20).join(', ');
    return `Error: Unknown technology "${technology}" — no dated documentation-updates page was found. `
      + `Known technologies include: ${examples || 'SwiftUI updates, UIKit updates, AppKit updates'}. `
      + 'Use list_technologies or the index mode (detail="index") to browse.';
  }

  const cacheKey = generateUrlCacheKey('documentation-updates-timeline', {
    detail: 'timeline',
    slug: page.slug,
    category,
    year,
    searchQuery,
    includeBeta,
    limit,
  });

  const cachedResult = updatesCache.get<string>(cacheKey);
  if (cachedResult) {
    logger.debug('Updates timeline cache hit');
    return cachedResult;
  }

  const documentUrl = `${APPLE_URLS.BASE}/tutorials/data/documentation/updates/${encodeURIComponent(page.slug)}.json`;
  const doc = await httpClient.getJson<TimelineDocument>(documentUrl);

  const parsed = parseTimelineDocument(doc);
  const sourceTitle = parsed.title || page.title;
  const filtered = applyTimelineFilters(parsed.sections, { year, searchQuery });
  const totalChanges = countTimelineEntries(filtered);

  if (totalChanges === 0) {
    return `No dated updates found for ${sourceTitle}${year ? ` in ${year}` : ''}`
      + `${searchQuery ? ` matching "${searchQuery}"` : ''}.`;
  }

  const result = formatUpdatesTimeline(sourceTitle, parsed.abstract, filtered, totalChanges, limit);
  updatesCache.set(cacheKey, result);
  return result;
}

/**
 * Parse updates data
 */
function parseUpdates(updatesData: UpdatesData, updatesIndex: UpdatesIndexData) {
  const updates: UpdateItem[] = [];

  // Process main updates sections
  if (updatesData.topicSections) {
    updatesData.topicSections.forEach(section => {
      const sectionCategory = getSectionCategory(section.title);
      // Apple publishes past WWDC coverage under a "Past releases" section,
      // so the section title alone cannot classify its entries as WWDC.
      const isPastReleases = /past\s*releases?/i.test(section.title);

      section.identifiers.forEach(identifier => {
        const reference = updatesData.references[identifier];
        if (reference) {
          const looksLikeWwdc = /^WWDC\d{2,4}$/i.test(reference.title ?? '')
            || /wwdc\d{2,4}/i.test(reference.url ?? '');
          const itemCategory: UpdateCategory = isPastReleases && looksLikeWwdc
            ? 'wwdc'
            : sectionCategory;

          const updateItem: UpdateItem = {
            title: reference.title,
            url: reference.url ? `https://developer.apple.com${reference.url}` : '',
            description: reference.abstract?.[0]?.text ?? '',
            category: itemCategory,
            type: reference.kind ?? 'update',
            identifier,
            images: reference.images,
          };

          // Extract year from WWDC titles
          if (itemCategory === 'wwdc' && reference.title) {
            const yearMatch = reference.title.match(/WWDC(\d{2,4})/);
            if (yearMatch) {
              updateItem.year = yearMatch[1].length === 2 ? `20${yearMatch[1]}` : yearMatch[1];
            }
          }

          updates.push(updateItem);
        }
      });
    });
  }

  // Process index data for additional details and beta information
  if (updatesIndex.interfaceLanguages?.swift) {
    processIndexSection(updatesIndex.interfaceLanguages.swift, updates);
  }

  return updates;
}

/**
 * Process index section recursively
 */
function processIndexSection(sections: UpdatesIndexSection[], updates: UpdateItem[]) {
  sections.forEach(section => {
    // Find corresponding update item
    const matchingUpdate = updates.find(u =>
      u.url.includes(section.path) ||
      u.title === section.title,
    );

    if (matchingUpdate) {
      matchingUpdate.beta = section.beta ?? false;
      matchingUpdate.technology = extractTechnologyFromPath(section.path);
    }

    // Process children
    if (section.children) {
      processIndexSection(section.children, updates);
    }
  });
}

/**
 * Get section category
 */
function getSectionCategory(title: string): UpdateCategory {
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('wwdc')) {
    return 'wwdc';
  }
  if (lowerTitle.includes('release notes')) {
    return 'release-notes';
  }
  if (lowerTitle.includes('technology')) {
    return 'technology';
  }
  return 'other';
}

/**
 * Extract technology from path
 */
function extractTechnologyFromPath(path: string): string | undefined {
  const match = path.match(/\/documentation\/updates\/([^/]+)/i);
  if (match?.[1]) {
    // Convert to proper case
    return match[1].replace(/-/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return undefined;
}

/**
 * Apply filters to updates
 */
function applyUpdatesFilters(
  updates: UpdateItem[],
  filters: {
    category?: string;
    technology?: string;
    year?: string;
    searchQuery?: string;
    includeBeta?: boolean;
    limit?: number;
  },
): UpdateItem[] {
  let filtered = [...updates];

  // Category filter
  if (filters.category && filters.category !== 'all') {
    filtered = filtered.filter(update => update.category === filters.category);
  }

  // Technology filter
  if (filters.technology) {
    const techLower = filters.technology.toLowerCase();
    filtered = filtered.filter(update =>
      (update.technology?.toLowerCase().includes(techLower)) ||
      update.title.toLowerCase().includes(techLower) ||
      update.description.toLowerCase().includes(techLower),
    );
  }

  // Year filter (for WWDC)
  if (filters.year) {
    filtered = filtered.filter(update => update.year === filters.year);
  }

  // Search query filter
  if (filters.searchQuery) {
    const queryLower = filters.searchQuery.toLowerCase();
    filtered = filtered.filter(update =>
      update.title.toLowerCase().includes(queryLower) ||
      update.description.toLowerCase().includes(queryLower),
    );
  }

  // Beta filter
  if (!filters.includeBeta) {
    filtered = filtered.filter(update => !update.beta);
  }

  // Apply limit
  if (filters.limit && filters.limit > 0) {
    filtered = filtered.slice(0, filters.limit);
  }

  return filtered;
}

/**
 * Format updates list
 */
function formatUpdatesList(updates: UpdateItem[]): string {
  if (updates.length === 0) {
    return 'No documentation updates found matching the specified criteria.';
  }

  let content = '# Apple Developer Documentation Updates\n\n';

  // Group by category
  const grouped = updates.reduce((acc, update) => {
    const category = update.category;
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(update);
    return acc;
  }, {} as Record<string, UpdateItem[]>);

  // Format each category
  const categoryTitles: Record<string, string> = {
    'wwdc': 'WWDC',
    'technology': 'Technology Updates',
    'release-notes': 'Release Notes',
    'other': 'Other Updates',
  };

  Object.entries(grouped).forEach(([category, items]) => {
    content += `## ${categoryTitles[category] ?? category}\n\n`;

    // Add WWDC-specific suggestion
    if (category === 'wwdc' && items.length > 0) {
      content += '> **💡 Tip:** For comprehensive WWDC video content with full transcripts and code examples, use the dedicated WWDC tools:\n';
      content += '> - `list_wwdc_videos` - Browse videos by year, topic, or code availability\n';
      content += '> - `search_wwdc_content` - Search through video transcripts and code\n';
      content += '> - `browse_wwdc_topics` - Explore videos by topic categories\n\n';
    }

    items.forEach(item => {
      // Build title with badges
      let titleLine = `### [${item.title}](${item.url})`;

      const badges = [];
      if (item.beta) {
        badges.push('Beta');
      }
      if (item.images?.some(img => img.identifier === 'new.svg')) {
        badges.push('New');
      }

      if (badges.length > 0) {
        titleLine += ` *${badges.join(' | ')}*`;
      }

      content += titleLine + '\n';

      // Add description
      if (item.description) {
        content += `${item.description}\n`;
      }

      // Add metadata
      const metadata = [];
      if (item.technology && item.category !== 'technology') {
        metadata.push(`Technology: ${item.technology}`);
      }
      if (item.year && item.category === 'wwdc') {
        metadata.push(`Year: ${item.year}`);
      }

      if (metadata.length > 0) {
        content += `*${metadata.join(' | ')}*\n`;
      }

      content += '\n';
    });
  });

  content += '\n---\n\n[View all updates on Apple Developer](https://developer.apple.com/documentation/updates)';

  return content;
}

/**
 * Update item interface
 */
interface UpdateItem {
  title: string;
  url: string;
  description: string;
  category: UpdateCategory;
  type: string;
  identifier: string;
  technology?: string;
  year?: string;
  beta?: boolean;
  images?: Array<{ type: string; identifier: string }>;
}

type UpdateCategory = 'wwdc' | 'technology' | 'release-notes' | 'other';

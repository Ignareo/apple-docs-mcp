/**
 * Document formatting utilities
 */

import type { AppleDocJSON } from '../types/apple-docs.js';

/**
 * Format document header with title and status
 */
export function formatDocumentHeader(jsonData: AppleDocJSON): string {
  let content = '';

  // Add title with status information
  const title = jsonData.metadata?.title ?? jsonData.title ?? 'Documentation';
  const statusInfo = [];

  // Check for beta/deprecated status
  const isBeta = jsonData.metadata?.platforms?.some((p) => p.beta) ?? false;
  // Apple signals deprecation with deprecatedAt, not the boolean deprecated flag.
  const isDeprecated = isDeprecatedDocument(jsonData);

  if (isBeta) {
    statusInfo.push('Beta');
  }
  if (isDeprecated) {
    statusInfo.push('Deprecated');
  }

  const statusText = statusInfo.length > 0 ? ` (${statusInfo.join(', ')})` : '';
  content += `# ${title}${statusText}\n\n`;

  // Add role/type information with symbol kind
  if (jsonData.metadata?.roleHeading) {
    let roleInfo = `**${jsonData.metadata.roleHeading}**`;
    if (jsonData.metadata?.symbolKind) {
      roleInfo += ` (${jsonData.metadata.symbolKind})`;
    }
    content += `${roleInfo}\n\n`;
  }

  return content;
}

/**
 * Format document abstract
 */
export function formatDocumentAbstract(jsonData: AppleDocJSON): string {
  if (!jsonData.abstract || !Array.isArray(jsonData.abstract)) {
    return '';
  }

  const abstractText = jsonData.abstract
    .map((item) => (item as { text?: string })?.text ?? '')
    .join(' ')
    .trim();

  return abstractText ? `${abstractText}\n\n` : '';
}

/**
 * Format platform availability section
 */
export function formatPlatformAvailability(jsonData: AppleDocJSON): string {
  if (!jsonData.metadata?.platforms || !Array.isArray(jsonData.metadata.platforms)) {
    return '';
  }

  let content = '## Platform Availability\n\n';

  jsonData.metadata.platforms.forEach((platform) => {
    content += formatPlatformLine(platform);
  });

  return content + '\n';
}

/**
 * Format a single platform line
 */
function formatPlatformLine(platform: any): string {
  const platformStatus = [];

  if (platform.beta) {
    platformStatus.push('Beta');
  }
  if (platform.deprecated || typeof platform.deprecatedAt === 'string') {
    platformStatus.push('Deprecated');
  }
  if (platform.unavailable) {
    platformStatus.push('Unavailable');
  }

  let platformLine = `- **${platform.name}** ${platform.introducedAt ?? 'Unknown'}+`;

  if (platform.deprecatedAt) {
    platformLine += ` | Deprecated in ${platform.deprecatedAt}`;
  }
  if (platform.obsoletedAt) {
    platformLine += ` | Obsoleted in ${platform.obsoletedAt}`;
  }
  if (platformStatus.length > 0) {
    platformLine += ` | Status: ${platformStatus.join(', ')}`;
  }

  return `${platformLine}\n`;
}

/**
 * Format See Also section
 */
export function formatSeeAlsoSection(jsonData: AppleDocJSON): string {
  if (!jsonData.seeAlsoSections || !Array.isArray(jsonData.seeAlsoSections)) {
    return '';
  }

  let content = '## See Also\n\n';

  jsonData.seeAlsoSections.forEach((seeAlso) => {
    if (seeAlso.title && seeAlso.identifiers) {
      content += `### ${seeAlso.title}\n\n`;
      content += formatSeeAlsoIdentifiers(jsonData, seeAlso.identifiers);
    }
  });

  return content;
}

/**
 * Format See Also identifiers
 */
function formatSeeAlsoIdentifiers(jsonData: AppleDocJSON, identifiers: string[]): string {
  let content = '';

  identifiers.forEach((identifier: string) => {
    const apiName = getReferenceTitle(jsonData, identifier);
    const apiUrl = generateApiUrlFromIdentifier(identifier);
    content += `- [${apiName}](${apiUrl})\n`;
  });

  return content + '\n';
}

/**
 * Resolve the human-readable label for a reference identifier.
 *
 * Apple's JSON payload normally carries a `title` for every reference; fall
 * back to the last path segment of the identifier when it is missing.
 */
export function getReferenceTitle(jsonData: AppleDocJSON, identifier: string): string {
  const title = jsonData.references?.[identifier]?.title;
  if (typeof title === 'string' && title.trim() !== '') {
    return title;
  }
  return identifierSlug(identifier);
}

/**
 * Last path segment of an identifier, with any doc:// bundle prefix removed.
 */
function identifierSlug(identifier: string): string {
  const withoutFragment = identifier.split('#')[0] ?? identifier;
  const withoutBundle = withoutFragment.replace(/^doc:\/\/[^/]+/i, '');
  const segments = withoutBundle.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? identifier;
}

/**
 * Build a public developer.apple.com documentation URL from an identifier.
 *
 * Handles `doc://<bundle>/documentation/<path>` identifiers as well as plain
 * paths/URLs, and keeps any `#fragment` anchor intact.
 */
export function generateApiUrlFromIdentifier(identifier: string): string {
  const trimmed = (identifier ?? '').trim();
  if (!trimmed) {
    return 'https://developer.apple.com/documentation';
  }

  let path = trimmed;
  let fragment = '';
  const hashIndex = path.indexOf('#');
  if (hashIndex !== -1) {
    fragment = path.slice(hashIndex);
    path = path.slice(0, hashIndex);
  }

  const isDocIdentifier = /^doc:\/\//i.test(path);
  if (isDocIdentifier) {
    // Strip the doc://<bundle> prefix (any bundle id, not just SwiftUI).
    path = path.replace(/^doc:\/\/[^/]+/i, '');
  }

  const documentationMarker = '/documentation/';
  const markerIndex = path.toLowerCase().indexOf(documentationMarker);
  let segments: string[];

  if (markerIndex !== -1) {
    segments = path.slice(markerIndex + documentationMarker.length).split('/').filter(Boolean);
  } else if (isDocIdentifier) {
    segments = path.split('/').filter(Boolean);
  } else {
    // Non doc:// identifier: fall back to its last path segment.
    const lastSegment = path.split('/').filter(Boolean).pop();
    segments = lastSegment ? [lastSegment] : [];
  }

  if (segments.length === 0) {
    return 'https://developer.apple.com/documentation';
  }

  const apiPath = segments
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment for malformed percent-encoding.
      }
      return decoded.toLowerCase();
    })
    .join('/');

  return `https://developer.apple.com/documentation/${apiPath}${fragment}`;
}

/**
 * Apple content blocks are only loosely typed in this fork, so the renderer
 * reads them structurally and silently skips anything it does not understand.
 */
interface RenderableBlock {
  type?: string;
  [key: string]: unknown;
}

interface RenderableReference {
  title?: unknown;
  alt?: unknown;
  url?: unknown;
  variants?: unknown;
  metadata?: unknown;
}

/**
 * tabNavigator output budget: Apple pages can nest many tabs and very large
 * tab bodies, so cap both the number of tabs and each tab's rendered content.
 */
export const TAB_NAVIGATOR_MAX_TABS = 4;
export const TAB_NAVIGATOR_MAX_CONTENT_CHARS = 2500;

type DeprecatableDoc = AppleDocJSON & {
  deprecationSummary?: unknown;
  metadata?: AppleDocJSON['metadata'] & { deprecationSummary?: unknown };
};

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toBlock(value: unknown): RenderableBlock | null {
  return value !== null && typeof value === 'object' ? (value as RenderableBlock) : null;
}

/**
 * Resolve a link destination, translating doc:// identifiers into public URLs.
 */
function resolveLinkDestination(destination: string): string {
  if (destination.startsWith('doc://')) {
    return generateApiUrlFromIdentifier(destination);
  }
  return destination;
}

/**
 * Wrap inline content in a markdown marker, leaving empty content untouched.
 */
function wrapInline(marker: string, inner: string): string {
  return inner.trim() !== '' ? `${marker}${inner}${marker}` : '';
}

/**
 * Render a single inline content run.
 *
 * Handles text, codeVoice, emphasis, strong, link and reference; unknown runs
 * are omitted so no HTML-ish noise leaks into the output.
 */
export function formatInlineContent(inlineContent: unknown, jsonData: AppleDocJSON): string {
  return toArray(inlineContent)
    .map((raw) => {
      const inline = toBlock(raw);
      if (!inline) {
        return '';
      }
      switch (inline.type) {
        case 'text':
          return toStringValue(inline.text);
        case 'codeVoice':
          return toStringValue(inline.code) ? `\`${toStringValue(inline.code)}\`` : '';
        case 'emphasis':
          return wrapInline('*', formatInlineContent(inline.inlineContent, jsonData));
        case 'strong':
          return wrapInline('**', formatInlineContent(inline.inlineContent, jsonData));
        case 'link': {
          const destination = resolveLinkDestination(toStringValue(inline.destination));
          const label = toStringValue(inline.title) || destination;
          return destination ? `[${label}](${destination})` : label;
        }
        case 'reference': {
          const identifier = toStringValue(inline.identifier);
          return identifier ? `\`${getReferenceTitle(jsonData, identifier)}\`` : '';
        }
        case 'image':
          return resolveImageMarkdown(inline, jsonData, false);
        default:
          return '';
      }
    })
    .join('');
}

/**
 * Render a fenced code block with a standalone opening fence (language tag)
 * and a standalone closing fence. All code emitters must go through this so a
 * closing fence can never be glued to the final code line.
 */
export function formatCodeBlock(code: string, language: string = 'swift'): string {
  const fence = '```';
  const trimmedCode = code.replace(/\s+$/, '');
  if (trimmedCode.trim() === '') {
    return '';
  }
  const languageTag = language.trim() || 'swift';
  return `${fence}${languageTag}\n${trimmedCode}\n${fence}\n\n`;
}

/**
 * Render an ordered/unordered list with a single level of nesting.
 */
function formatListBlock(block: RenderableBlock, jsonData: AppleDocJSON, ordered: boolean): string {
  const lines: string[] = [];

  toArray(block.items).forEach((rawItem, index) => {
    const item = toBlock(rawItem);
    if (!item) {
      return;
    }
    let itemText = formatContentBlocks(item.content, jsonData).replace(/\s+$/, '');
    if (itemText === '' && Array.isArray(item.inlineContent)) {
      itemText = formatInlineContent(item.inlineContent, jsonData).trim();
    }
    if (itemText === '') {
      return;
    }
    const marker = ordered ? `${index + 1}. ` : '- ';
    const itemLines = itemText.split('\n');
    lines.push(`${marker}${itemLines[0]}`);
    for (const continuation of itemLines.slice(1)) {
      lines.push(continuation === '' ? '' : `  ${continuation}`);
    }
  });

  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n')}\n\n`;
}

function renderTableCell(cell: unknown, jsonData: AppleDocJSON): string {
  let blocks: unknown[];
  if (Array.isArray(cell)) {
    blocks = cell;
  } else {
    const block = toBlock(cell);
    if (block && Array.isArray(block.content)) {
      blocks = block.content;
    } else if (block && Array.isArray(block.inlineContent)) {
      blocks = [{ type: 'paragraph', inlineContent: block.inlineContent }];
    } else {
      blocks = [];
    }
  }

  return formatContentBlocks(blocks, jsonData)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

/**
 * Render an Apple table as a markdown table. Apple always supplies a header
 * row (`header: "row"`, or `"column"` where the first column is the label
 * column); the first JSON row is used as the markdown header row.
 */
function formatTableBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const rows = toArray(block.rows)
    .map((row) => toArray(row).map((cell) => renderTableCell(cell, jsonData)))
    .filter((row) => row.length > 0);

  if (rows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [
    ...row,
    ...Array<string>(columnCount - row.length).fill(''),
  ]);
  const headerRow = normalized[0] ?? [];
  const bodyRows = normalized.slice(1);

  const lines = [
    `| ${headerRow.join(' | ')} |`,
    `| ${headerRow.map(() => '---').join(' | ')} |`,
  ];
  for (const row of bodyRows) {
    lines.push(`| ${row.join(' | ')} |`);
  }

  return `${lines.join('\n')}\n\n`;
}

/**
 * Render an aside as a blockquote with a bold style label.
 */
function formatAsideBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const inner = formatContentBlocks(block.content, jsonData).replace(/\s+$/, '');
  const style = toStringValue(block.name) || toStringValue(block.style) || 'note';
  const label = style.charAt(0).toUpperCase() + style.slice(1);
  const body = inner === '' ? `**${label}:**` : `**${label}:** ${inner}`;

  return (
    body
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n') + '\n\n'
  );
}

/**
 * Find the reference entry an image/video block points at. Apple uses the
 * asset identifier as the reference key; older payloads may only carry `name`.
 * Some blocks also inline their own `variants`/`url`, so callers fall back to
 * the block itself when no reference matches.
 */
function resolveMediaReference(
  block: RenderableBlock,
  jsonData: AppleDocJSON,
): RenderableReference | undefined {
  const identifier = toStringValue(block.identifier) || toStringValue(block.name);
  if (identifier === '') {
    return undefined;
  }
  return jsonData.references?.[identifier] as unknown as RenderableReference | undefined;
}

function firstVariantUrl(variants: unknown): string {
  return (
    toArray(variants)
      .map((variant) => toStringValue(toBlock(variant)?.url))
      .find((url) => url !== '') ?? ''
  );
}

/**
 * Resolve a media URL from the reference, the block itself, or any variant
 * (`variants[].url` always carries `traits`, sometimes only `svgID`/`traits`).
 */
function resolveMediaUrl(
  block: RenderableBlock,
  reference: RenderableReference | undefined,
): string {
  const rawUrl =
    toStringValue(reference?.url) ||
    toStringValue(block.url) ||
    firstVariantUrl(reference?.variants) ||
    firstVariantUrl(block.variants) ||
    '';
  if (rawUrl === '') {
    return '';
  }
  if (rawUrl.startsWith('http')) {
    return rawUrl;
  }
  return `https://developer.apple.com${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`;
}

/** Flatten an inline-content array to plain text (used for image captions). */
function inlinePlainText(value: unknown): string {
  return toArray(value)
    .map((raw) => {
      const inline = toBlock(raw);
      if (!inline) {
        return '';
      }
      return toStringValue(inline.text) || toStringValue(inline.code);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve image alt text. Apple stores it on the reference most of the time,
 * but HIG rows put the visible caption in `metadata.abstract` and inline
 * images may carry their own `alt`.
 */
function resolveMediaAlt(
  block: RenderableBlock,
  reference: RenderableReference | undefined,
): string {
  const metadata = toBlock(block.metadata);
  const referenceMetadata = toBlock(reference?.metadata);
  return (
    toStringValue(block.alt) ||
    inlinePlainText(metadata?.abstract) ||
    inlinePlainText(referenceMetadata?.abstract) ||
    toStringValue(reference?.alt) ||
    toStringValue(metadata?.alt) ||
    ''
  );
}

/**
 * Render an image reference as inline markdown. `allowEmptyAlt` is used for
 * standalone (paragraph-level) images so an image is never silently dropped
 * just because Apple omitted both alt text and caption.
 */
function resolveImageMarkdown(
  block: RenderableBlock,
  jsonData: AppleDocJSON,
  allowEmptyAlt: boolean,
): string {
  const reference = resolveMediaReference(block, jsonData);
  const url = resolveMediaUrl(block, reference);
  if (url === '') {
    return '';
  }
  const alt = resolveMediaAlt(block, reference);
  if (alt === '' && !allowEmptyAlt) {
    return '';
  }
  return `![${alt}](${url})`;
}

/**
 * Render an image block as `![alt](url)`, omitting it when no URL is known.
 */
function formatImageBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const markdown = resolveImageMarkdown(block, jsonData, true);
  return markdown === '' ? '' : `${markdown}\n\n`;
}

/**
 * Render a video block as a link to Apple's hosted video.
 */
function formatVideoBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const reference = resolveMediaReference(block, jsonData);
  const url = resolveMediaUrl(block, reference);
  if (url === '') {
    return '';
  }
  const label = resolveMediaAlt(block, reference) || 'Video';
  return `[${label}](${url})\n\n`;
}

/**
 * Render a `row`/`columns` layout block by emitting each column's content in
 * order. This is how HIG pages place side-by-side screenshots and captions.
 */
function formatColumnsBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const columns = toArray(block.columns).length > 0 ? toArray(block.columns) : toArray(block.content);
  const rendered = columns
    .map((column) => formatContentBlocks(toBlock(column)?.content, jsonData).replace(/\s+$/, ''))
    .filter((text) => text !== '');
  if (rendered.length === 0) {
    return '';
  }
  return `${rendered.join('\n\n')}\n\n`;
}

/**
 * Render a `termList` (Apple's term/definition list) as a bullet list.
 */
function formatTermListBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const lines: string[] = [];

  toArray(block.items).forEach((rawItem) => {
    const item = toBlock(rawItem);
    if (!item) {
      return;
    }
    const term = formatInlineContent(toBlock(item.term)?.inlineContent, jsonData).trim();
    const definition = formatContentBlocks(toBlock(item.definition)?.content, jsonData)
      .replace(/\s+/g, ' ')
      .trim();

    if (term === '' && definition === '') {
      return;
    }
    if (term === '') {
      lines.push(`- ${definition}`);
      return;
    }
    lines.push(definition === '' ? `- **${term}**` : `- **${term}**: ${definition}`);
  });

  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`;
}

/**
 * Render a links block as a compact bullet list.
 */
function formatLinksBlock(block: RenderableBlock): string {
  const lines: string[] = [];

  toArray(block.items).forEach((rawItem) => {
    const item = toBlock(rawItem);
    if (!item) {
      return;
    }
    const title = toStringValue(item.title);
    const destination = resolveLinkDestination(
      toStringValue(item.url) || toStringValue(item.destination),
    );
    if (destination !== '') {
      lines.push(`- [${title || destination}](${destination})`);
    } else if (title !== '') {
      lines.push(`- ${title}`);
    }
  });

  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * Render blocks for a single tab, stopping before the rendered text exceeds
 * `maxChars`. A block is never split, so code fences and tables stay valid.
 */
function formatContentBlocksWithinBudget(
  blocks: unknown,
  jsonData: AppleDocJSON,
  maxChars: number,
): { text: string; truncated: boolean } {
  const rendered: string[] = [];
  let length = 0;
  let truncated = false;

  for (const raw of toArray(blocks)) {
    const text = formatContentBlock(raw, jsonData);
    if (text === '') {
      continue;
    }
    if (rendered.length > 0 && length + text.length > maxChars) {
      truncated = true;
      break;
    }
    rendered.push(text);
    length += text.length;
  }

  let text = rendered.join('');
  // A single block can exceed the budget on its own; hard-cap it at a
  // character boundary and re-close any code fence the cut opened so the
  // markdown stays valid.
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    if (((text.match(/```/g) ?? []).length) % 2 === 1) {
      text += '\n```';
    }
    truncated = true;
  }

  return { text, truncated };
}

/**
 * Render a tab navigator by emitting every tab (labeled) within a deterministic
 * budget: at most TAB_NAVIGATOR_MAX_TABS tabs, each capped at
 * TAB_NAVIGATOR_MAX_CONTENT_CHARS rendered characters. Omitted/truncated parts
 * are called out explicitly so the output never silently loses content.
 */
function formatTabNavigatorBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const tabs = toArray(block.tabs)
    .map((tab) => toBlock(tab))
    .filter((tab): tab is RenderableBlock => tab !== null);
  if (tabs.length === 0) {
    return '';
  }

  const renderedTabs = tabs.slice(0, TAB_NAVIGATOR_MAX_TABS);
  const parts: string[] = [];

  renderedTabs.forEach((tab) => {
    const label = toStringValue(tab.title).trim();
    const { text, truncated } = formatContentBlocksWithinBudget(
      tab.content,
      jsonData,
      TAB_NAVIGATOR_MAX_CONTENT_CHARS,
    );
    let section = label === '' ? text : `**${label}**\n\n${text}`;
    if (truncated) {
      section += `${section.endsWith('\n\n') || section === '' ? '' : '\n'}… (tab truncated)\n\n`;
    }
    if (section !== '') {
      parts.push(section);
    }
  });

  const omitted = tabs.length - renderedTabs.length;
  if (omitted > 0) {
    parts.push(`… ${omitted} more tab${omitted === 1 ? '' : 's'} omitted\n\n`);
  }

  return parts.join('');
}

/**
 * Render a single structured content block.
 */
function formatContentBlock(raw: unknown, jsonData: AppleDocJSON): string {
  const block = toBlock(raw);
  if (!block) {
    return '';
  }

  switch (block.type) {
    case 'heading': {
      const text = toStringValue(block.text).trim();
      if (text === '') {
        return '';
      }
      const level = normalizeHeadingLevel(block.level);
      return `${'#'.repeat(level)} ${text}\n\n`;
    }
    case 'paragraph': {
      // Apple commonly stores an illustration as the only inlineContent run of
      // an otherwise empty paragraph. Render it even without alt text.
      const runs = toArray(block.inlineContent);
      if (runs.length === 1) {
        const soleRun = toBlock(runs[0]);
        if (soleRun?.type === 'image') {
          const markdown = resolveImageMarkdown(soleRun, jsonData, true);
          return markdown === '' ? '' : `${markdown}\n\n`;
        }
      }
      const text = formatInlineContent(block.inlineContent, jsonData).trim();
      return text === '' ? '' : `${text}\n\n`;
    }
    case 'codeListing':
      return formatCodeBlock(
        Array.isArray(block.code)
          ? block.code.map((line) => toStringValue(line)).join('\n')
          : toStringValue(block.code),
        toStringValue(block.syntax),
      );
    case 'unorderedList':
      return formatListBlock(block, jsonData, false);
    case 'orderedList':
      return formatListBlock(block, jsonData, true);
    case 'table':
      return formatTableBlock(block, jsonData);
    case 'termList':
      return formatTermListBlock(block, jsonData);
    case 'aside':
      return formatAsideBlock(block, jsonData);
    case 'image':
      return formatImageBlock(block, jsonData);
    case 'video':
      return formatVideoBlock(block, jsonData);
    case 'row':
    case 'columns':
      return formatColumnsBlock(block, jsonData);
    case 'links':
      return formatLinksBlock(block);
    case 'tabNavigator':
      return formatTabNavigatorBlock(block, jsonData);
    default:
      return '';
  }
}

/**
 * Render a list of structured content blocks. Shared by article/collection
 * pages and symbol pages so every block type is handled once.
 */
export function formatContentBlocks(blocks: unknown, jsonData: AppleDocJSON): string {
  return toArray(blocks)
    .map((block) => formatContentBlock(block, jsonData))
    .join('');
}

function normalizeHeadingLevel(level: unknown): number {
  const numeric = typeof level === 'number' && Number.isFinite(level) ? Math.trunc(level) : 2;
  // Doc titles already occupy H1, so content headings start at H2.
  return Math.min(Math.max(numeric, 2), 6);
}

/**
 * Apple marks a page deprecated through `metadata.platforms[].deprecatedAt`
 * (it does not set `platform.deprecated`), so check both signals.
 */
export function isDeprecatedDocument(jsonData: AppleDocJSON): boolean {
  return (
    jsonData.metadata?.platforms?.some(
      (platform) => platform.deprecated === true || typeof platform.deprecatedAt === 'string',
    ) ?? false
  );
}

function getDeprecationSummary(jsonData: AppleDocJSON): unknown[] {
  const source = jsonData as DeprecatableDoc;
  const summary = source.deprecationSummary ?? source.metadata?.deprecationSummary;
  return Array.isArray(summary) ? summary : [];
}

/**
 * Format the optional "## Deprecation" section from `deprecationSummary`.
 * Apple stores it top-level (array of paragraph blocks); a metadata copy and
 * a bare inline-content array are also accepted defensively.
 */
export function formatDeprecationSection(jsonData: AppleDocJSON): string {
  const summary = getDeprecationSummary(jsonData);
  if (summary.length === 0) {
    return '';
  }

  const looksLikeBlocks = summary.some((item) => {
    const block = toBlock(item);
    return (
      !!block &&
      (block.type === 'paragraph' ||
        block.type === 'heading' ||
        block.type === 'unorderedList' ||
        block.type === 'orderedList' ||
        block.type === 'table' ||
        block.type === 'aside' ||
        block.type === 'codeListing')
    );
  });

  const rendered = looksLikeBlocks
    ? formatContentBlocks(summary, jsonData)
    : formatInlineContent(summary, jsonData);
  const text = rendered.replace(/\s+$/, '');
  if (text === '') {
    return '';
  }

  return `## Deprecation\n\n${text}\n\n`;
}

/**
 * Check if document is a specific API
 */
export function isSpecificAPIDocument(jsonData: AppleDocJSON): boolean {
  return jsonData.primaryContentSections?.some(
    (section) => (section as { kind?: string })?.kind === 'declarations',
  ) ?? false;
}
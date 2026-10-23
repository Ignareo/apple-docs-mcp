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
  variants?: Array<{ url?: unknown }>;
}

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
 * Render an image block as `![alt](url)`, omitting it when no URL is known.
 */
function formatImageBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const identifier = toStringValue(block.identifier) || toStringValue(block.name);
  const reference = identifier
    ? (jsonData.references?.[identifier] as unknown as RenderableReference | undefined)
    : undefined;

  const variantUrl = toArray(reference?.variants)
    .map((variant) => toStringValue(toBlock(variant)?.url))
    .find((url) => url !== '');
  const rawUrl = toStringValue(reference?.url) || variantUrl || '';
  if (rawUrl === '') {
    return '';
  }

  const url = rawUrl.startsWith('http') ? rawUrl : `https://developer.apple.com${rawUrl}`;
  const metadata = toBlock(block.metadata);
  const alt =
    toStringValue(block.alt) ||
    toStringValue(reference?.alt) ||
    toStringValue(metadata?.alt) ||
    '';

  return `![${alt}](${url})\n\n`;
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
 * Render a tab navigator by emitting its first tab (labeled) to keep the
 * output deterministic; a page with no tabs renders nothing.
 */
function formatTabNavigatorBlock(block: RenderableBlock, jsonData: AppleDocJSON): string {
  const tabs = toArray(block.tabs)
    .map((tab) => toBlock(tab))
    .filter((tab): tab is RenderableBlock => tab !== null);
  if (tabs.length === 0) {
    return '';
  }

  const firstTab = tabs[0];
  const label = toStringValue(firstTab.title).trim();
  const inner = formatContentBlocks(firstTab.content, jsonData);

  if (label === '') {
    return inner;
  }
  return `**${label}**\n\n${inner}`;
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
    case 'aside':
      return formatAsideBlock(block, jsonData);
    case 'image':
      return formatImageBlock(block, jsonData);
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
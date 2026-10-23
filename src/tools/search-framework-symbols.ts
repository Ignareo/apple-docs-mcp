import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { indexCache, generateUrlCacheKey } from '../utils/cache.js';
import {
  APPLE_URLS,
  API_LIMITS,
  PROCESSING_LIMITS,
  FRAMEWORK_INDEX_TIMEOUT,
} from '../utils/constants.js';
import { httpClient } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { normalizeFrameworkName } from '../utils/framework-mapper.js';
import { describeError, describeToolError, isNotFoundError } from '../utils/error-handler.js';

/**
 * MCP Tool Definition
 */
export const searchFrameworkSymbolsTool: Tool = {
  name: 'search_framework_symbols',
  description: 'Browse and search symbols within one Apple framework: classes, structs, enums, protocols, methods and properties. Output reports "Found X of Y" and skips group-marker entries. Use list_technologies for framework identifiers.',
  inputSchema: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        description: 'Framework identifier in lowercase. Common: "uikit", "swiftui", "foundation", "combine", "coredata". Get exact names from list_technologies. Example: "swiftui" for SwiftUI framework.',
      },
      symbolType: {
        type: 'string',
        enum: ['all', 'class', 'struct', 'enum', 'protocol', 'method', 'property', 'init', 'func', 'var', 'let', 'typealias'],
        description: 'Filter by symbol type. Use "class" for UIViewController subclasses, "protocol" for delegates, "struct" for value types. Default: "all" shows everything.',
      },
      namePattern: {
        type: 'string',
        description: 'Filter by name pattern. Use "*View" for all views, "UI*" for UI-prefixed symbols, "*Delegate" for delegates. Case-sensitive. Leave empty for all symbols.',
      },
      language: {
        type: 'string',
        enum: ['swift', 'occ'],
        description: 'Language preference. Some APIs differ between Swift and Objective-C. Default: "swift"',
      },
      limit: {
        type: 'number',
        description: `Results limit (default: ${API_LIMITS.DEFAULT_FRAMEWORK_SYMBOLS_LIMIT}, max: ${API_LIMITS.MAX_FRAMEWORK_SYMBOLS_LIMIT}). Includes nested symbols.`,
        minimum: 1,
        maximum: API_LIMITS.MAX_FRAMEWORK_SYMBOLS_LIMIT,
      },
    },
    required: ['framework'],
  },
  annotations: {
    title: 'Search Framework Symbols',
    readOnlyHint: true,
  },
};

interface IndexItem {
  path: string;
  title: string;
  type: string;
  beta?: boolean;
  deprecated?: boolean;
  external?: boolean;
  children?: IndexItem[];
}

interface FrameworkIndex {
  interfaceLanguages: {
    [language: string]: IndexItem[];
  };
}

/** Maximum recursion depth for nested index collections. */
const MAX_INDEX_DEPTH = 6;

/**
 * Build the Apple index URL for a framework.
 *
 * Kept in one place so the preloader and the live tool share the exact same
 * URL (and therefore the same raw-index cache entry).
 */
export function getFrameworkIndexUrl(framework: string): string {
  return `${APPLE_URLS.TUTORIALS_DATA}index/${framework.toLowerCase()}`;
}

/**
 * Cache key for the raw framework index JSON.
 *
 * This key is deliberately independent of symbolType/namePattern/language/limit:
 * the raw index is the expensive network payload and can be reused by every
 * query against the same framework, including the startup preloader.
 */
export function getFrameworkIndexCacheKey(indexUrl: string): string {
  return `framework-index-json:${indexUrl}`;
}

/**
 * In-flight raw index requests, keyed by index URL.
 *
 * Preloading runs in the background while the first user queries arrive; without
 * this map the preloader and a foreground query would download the same
 * multi-megabyte index twice. Sharing the promise keeps it to one download.
 */
const inFlightIndexRequests = new Map<string, Promise<FrameworkIndex>>();

/**
 * Fetch a framework's raw index JSON, using the shared raw-index cache.
 *
 * The request gets a longer-than-default timeout because Apple's framework
 * index files can be several megabytes and frequently take >30s.
 */
async function fetchFrameworkIndex(indexUrl: string): Promise<FrameworkIndex> {
  const cacheKey = getFrameworkIndexCacheKey(indexUrl);
  const cached = indexCache.get<FrameworkIndex>(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightIndexRequests.get(indexUrl);
  if (inFlight) {
    return inFlight;
  }

  const request = httpClient
    .getJson<FrameworkIndex>(indexUrl, { timeout: FRAMEWORK_INDEX_TIMEOUT })
    .then((data) => {
      indexCache.set(cacheKey, data);
      return data;
    })
    .finally(() => {
      inFlightIndexRequests.delete(indexUrl);
    });

  inFlightIndexRequests.set(indexUrl, request);
  return request;
}

/**
 * Warm the raw index cache for a single framework.
 *
 * This is what the background preloader should call: it only downloads/caches
 * the raw JSON (no limit-dependent formatting), so any later query for this
 * framework reuses it without another network round-trip.
 */
export async function preloadFrameworkIndex(framework: string): Promise<void> {
  if (!framework?.trim()) {
    return;
  }
  await fetchFrameworkIndex(getFrameworkIndexUrl(framework));
}

/**
 * Whether an index item should be listed as a symbol result.
 *
 * - `groupMarker` entries are pure in-page headings without a `path`; listing
 *   them produced `https://developer.apple.comundefined` links and wasted result
 *   slots. Their children are still traversed.
 * - Items without a title are unusable in the output.
 */
function isListableSymbol(item: IndexItem): boolean {
  return item.type !== 'groupMarker' && Boolean(item.title?.trim());
}

/**
 * Collect all matching symbols recursively (no limit, so the total can be
 * reported exactly). Order is preserved; callers slice to the requested limit.
 */
function findSymbolsRecursive(
  items: IndexItem[],
  symbolType: string,
  namePattern: string | undefined,
  symbols: IndexItem[],
  depth: number = 0,
): void {
  if (depth > MAX_INDEX_DEPTH) {
    return;
  }

  for (const item of items) {
    // Check if symbol type matches
    if (
      isListableSymbol(item) &&
      (symbolType === 'all' || item.type === symbolType) &&
      (!namePattern || matchesPattern(item.title, namePattern))
    ) {
      symbols.push(item);
    }

    if (item.children) {
      findSymbolsRecursive(item.children, symbolType, namePattern, symbols, depth + 1);
    }
  }
}

export async function searchFrameworkSymbols(
  framework: string,
  symbolType: string = 'all',
  namePattern?: string,
  language: string = 'swift',
  limit: number = API_LIMITS.DEFAULT_FRAMEWORK_SYMBOLS_LIMIT,
): Promise<string> {
  try {
    // Normalize framework name for consistent processing
    const normalizedFramework = normalizeFrameworkName(framework);
    logger.info(`Searching ${symbolType} symbols in ${normalizedFramework} framework`);

    const indexUrl = getFrameworkIndexUrl(framework);

    // The formatted (limit-dependent) result is cached separately from the raw
    // index JSON so that changing limit/symbolType/namePattern still reuses the
    // already-downloaded index.
    const cacheKey = generateUrlCacheKey(indexUrl, {
      framework: normalizedFramework,
      symbolType,
      namePattern,
      language,
      limit,
    });

    // Check cache
    const cachedResult = indexCache.get<string>(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    const data = await fetchFrameworkIndex(indexUrl);

    // Get language-specific index
    const indexItems = data.interfaceLanguages?.[language] || [];

    if (indexItems.length === 0) {
      const availableLanguages = Object.keys(data.interfaceLanguages || {});
      return `Language "${language}" not available for ${framework}. Available languages: ${availableLanguages.join(', ')}`;
    }

    // Collect every match (cheap in-memory traversal) so we can report X of Y.
    const allMatches: IndexItem[] = [];
    findSymbolsRecursive(indexItems, symbolType, namePattern, allMatches);
    const totalMatches = allMatches.length;
    const symbols = allMatches.slice(0, limit);

    // Format results
    const typeLabel = symbolType === 'all' ? 'Symbols' : pluralizeType(symbolType);
    let result = `# ${framework} Framework ${typeLabel}\n\n`;

    if (symbols.length === 0) {
      const typeText = symbolType === 'all' ? 'symbols' : pluralizeType(symbolType).toLowerCase();
      result += `No ${typeText} found`;
      if (namePattern) {
        result += ` matching pattern "${namePattern}"`;
      }
      result += ` in ${framework} framework.\n`;

      // Suggest exploring collections
      const collections = findCollections(indexItems);
      if (collections.length > 0) {
        result += '\n## Try exploring these collections:\n\n';
        for (const col of collections.slice(0, PROCESSING_LIMITS.MAX_COLLECTIONS_TO_SHOW)) {
          result += `- [${col.title}](https://developer.apple.com${col.path})\n`;
        }
      }
    } else {
      result += `**Found:** ${symbols.length} of ${totalMatches} ${symbolType === 'all' ? 'symbols' : pluralizeType(symbolType).toLowerCase()}`;
      if (namePattern) {
        result += ` matching "${namePattern}"`;
      }
      result += '\n\n';

      // Group by type if searching all
      if (symbolType === 'all') {
        const grouped = groupByType(symbols);
        for (const [type, items] of Object.entries(grouped)) {
          result += `## ${pluralizeType(type)} (${items.length})\n\n`;
          for (const item of items) {
            result += formatSymbolItem(item);
          }
          result += '\n';
        }
      } else {
        // List symbols
        for (const symbol of symbols) {
          result += formatSymbolItem(symbol);
        }
      }
    }

    // Cache result
    indexCache.set(cacheKey, result);

    return result;

  } catch (error) {
    const message = describeError(error);
    const timedOut = /timeout|timed out|timedout|aborted due to timeout/i.test(message);
    let hint: string | undefined;
    if (isNotFoundError(error)) {
      hint = `framework "${framework}" not found; call list_technologies for valid identifiers`;
    } else if (timedOut) {
      hint = `the ${framework} framework index is large and the request timed out; retry — a second attempt often succeeds`;
    }
    logger.error(`Error searching symbols in ${framework} framework: ${message}`);
    return `Error: ${describeToolError('search_framework_symbols', error, hint)}`;
  }
}

function formatSymbolItem(item: IndexItem): string {
  const title = item.title.trim();

  // Group markers / odd entries may lack a path. Never render `undefined` into
  // the URL: fall back to a plain bold title.
  let result = item.path
    ? `- [**${title}**](https://developer.apple.com${item.path})`
    : `- **${title}**`;

  const metadata = [];
  if (item.beta) {
    metadata.push('Beta');
  }
  if (item.deprecated) {
    metadata.push('Deprecated');
  }
  if (item.type && item.type !== 'groupMarker') {
    metadata.push(formatTypeLabel(item.type));
  }

  if (metadata.length > 0) {
    result += ` *(${metadata.join(', ')})*`;
  }

  return result + '\n';
}

function groupByType(symbols: IndexItem[]): Record<string, IndexItem[]> {
  const groups: Record<string, IndexItem[]> = {};

  for (const symbol of symbols) {
    if (!groups[symbol.type]) {
      groups[symbol.type] = [];
    }
    groups[symbol.type].push(symbol);
  }

  return groups;
}

function formatTypeLabel(type: string): string {
  const typeLabels: Record<string, string> = {
    'symbol': 'Symbol',
    'module': 'Module',
    'class': 'Class',
    'struct': 'Struct',
    'enum': 'Enum',
    'protocol': 'Protocol',
    'method': 'Method',
    'property': 'Property',
    'init': 'Initializer',
    'case': 'Case',
    'associatedtype': 'Associated Type',
    'typealias': 'Type Alias',
    'article': 'Article',
    'sampleCode': 'Sample Code',
    'overview': 'Overview',
    'collection': 'Collection',
    'func': 'Function',
    'var': 'Variable',
    'let': 'Constant',
    'operator': 'Operator',
    'macro': 'Macro',
    'namespace': 'Namespace',
  };

  return typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

function pluralizeType(type: string): string {
  const typeLabel = formatTypeLabel(type);

  // Special cases for pluralization
  const pluralRules: Record<string, string> = {
    'Class': 'Classes',
    'Property': 'Properties',
    'Associated Type': 'Associated Types',
    'Type Alias': 'Type Aliases',
    'Sample Code': 'Sample Code',
  };

  return pluralRules[typeLabel] || typeLabel + 's';
}

function matchesPattern(name: string, pattern: string): boolean {
  const regexPattern = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(name);
}

function findCollections(items: IndexItem[]): IndexItem[] {
  const collections: IndexItem[] = [];

  function search(itemList: IndexItem[]) {
    for (const item of itemList) {
      if (item.type === 'collection') {
        collections.push(item);
      }
      if (item.children) {
        search(item.children);
      }
    }
  }

  search(items);
  return collections;
}

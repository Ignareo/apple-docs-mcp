/**
 * Search and indexing related types
 */

/**
 * Apple documentation search result
 */
export interface AppleDocSearchResult {
  title: string;
  url: string;
  description: string;
  type: string;
  platform?: string;
  isBeta?: boolean;
  isDeprecated?: boolean;
}

/**
 * Metadata of a single entry returned by Apple's JSONL search API
 * (https://devintserv.msc.sbz.apple.com/api/v1/query). Undocumented interface,
 * field presence is not guaranteed — every field is optional.
 */
export interface AppleSearchMetadata {
  title?: string;
  description?: string;
  availability?: string;
  hierarchy?: string;
  permalink?: string;
  kind?: string;
}

/**
 * A single item of the `search` response stream: hit excerpt plus nested metadata.
 */
export interface AppleSearchStreamItem {
  excerpt?: string;
  value?: {
    metadata?: AppleSearchMetadata;
  };
}

/**
 * A merged, deduplicated search result entry ready for markdown formatting.
 */
export interface AppleSearchApiResult {
  title: string;
  description: string;
  availability: string;
  hierarchy: string;
  permalink: string;
}

/**
 * Framework index structure
 */
export interface FrameworkIndex {
  interfaceLanguages: Record<string, unknown>;
  references?: Record<string, FrameworkReference>;
  relationships?: {
    modules?: Array<{
      title?: string;
      children?: IndexItem[];
    }>;
  };
}

/**
 * Framework reference item
 */
export interface FrameworkReference {
  title: string;
  url: string;
  type?: string;
  abstract?: unknown[];
  fragments?: Array<{
    kind: string;
    text: string;
  }>;
}

/**
 * Index item in framework hierarchy
 */
export interface IndexItem {
  title: string;
  type: string;
  path?: string;
  children?: IndexItem[];
}

/**
 * Symbol search result
 */
export interface SymbolSearchResult {
  name: string;
  type: string;
  path: string;
  framework: string;
  language: string;
  abstract?: string;
}
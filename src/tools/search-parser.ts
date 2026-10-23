/**
 * Search result formatting and tool entry point for search_apple_docs
 *
 * The search goes through Apple's JSONL search API (see search-api-client.ts,
 * ported from the verified apple-search-mcp/server.py reference
 * implementation). This module converts the merged API results into the
 * '# Apple Documentation Search Results' markdown the tool has always
 * returned, and wraps the whole call in explicit error handling — the backend
 * is an undocumented Apple interface and may change, so failures must never
 * be silently reported as "no results".
 */

import { searchAppleDocsApiDetailed } from './search-api-client.js';
import type { AppleSearchApiResult } from '../types/search.js';

/**
 * MCP tool response shape shared by all handlers
 */
export interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Error note appended to every backend failure (undocumented endpoint).
 */
const UNDOCUMENTED_API_NOTE = 'Note: this endpoint is an undocumented Apple interface and may have changed.';

/** Render options for a possibly-partial result set. */
export interface SearchFormatOptions {
  /** The backend stream was cut short; results may be incomplete. */
  partial?: boolean;
  /** Human-readable explanation of why the result set is partial. */
  partialReason?: string;
}

/** Tokens used for the weak-match heuristic (ASCII words only). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3);
}

/**
 * Heuristic: none of the query's words appear anywhere in the returned
 * entries. Apple's backend does fuzzy correction ("UIVIewControler" →
 * "UIViewController", nonsense → substring hits) and exposes no relevance
 * score, so this only *labels* a weak result set — it never suppresses it.
 *
 * CJK queries are skipped: whitespace tokenization is meaningless there and
 * a false "weak matches" banner would be worse than none.
 */
function isWeakMatch(query: string, results: AppleSearchApiResult[]): boolean {
  if (/[\u3400-\u9fff]/.test(query)) {
    return false;
  }
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return false;
  }
  const haystack = results
    .map(result => `${result.title} ${result.hierarchy} ${result.description}`)
    .join(' ')
    .toLowerCase();
  return !queryTokens.some(token => haystack.includes(token));
}

/** Normalize for title/description duplicate detection. */
function sameText(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * Format merged search results as markdown, matching the reference output:
 * numbered entries with type/hierarchy/description/availability/permalink.
 *
 * Entries whose description merely repeats the title are rendered once, and
 * partial result sets carry an explicit warning instead of looking complete.
 */
export function formatSearchResults(
  results: AppleSearchApiResult[],
  query: string,
  options: SearchFormatOptions = {},
): string {
  if (results.length === 0) {
    if (options.partial) {
      return `# Apple Documentation Search Results\n\n**Query:** "${query}"\n\nNo results could be recovered before the backend stream stopped.${options.partialReason ? `\n\n> ⚠️ ${options.partialReason}` : ''}`;
    }
    return `# Apple Documentation Search Results\n\n**Query:** "${query}"\n\nNo results.`;
  }

  const header = `**Query:** "${query}"  |  **Results:** ${results.length}`;
  const lines: string[] = [`# Apple Documentation Search Results\n\n${header}\n`];

  if (options.partial) {
    lines.push(`> ⚠️ ${options.partialReason ?? 'Partial results: the backend stream stopped early; the result set may be incomplete.'}\n`);
  }
  if (isWeakMatch(query, results)) {
    lines.push('> ⚠️ Weak matches: none of the query terms appear in these results. The backend may have returned fuzzy or substring matches.\n');
  }

  results.forEach((result, index) => {
    lines.push(`### ${index + 1}. ${result.title}`);
    if (result.type) {
      lines.push(`- Type: ${result.type}`);
    }
    if (result.hierarchy) {
      lines.push(`- Hierarchy: ${result.hierarchy}`);
    }
    if (result.description && !sameText(result.description, result.title)) {
      lines.push(`- ${result.description}`);
    }
    if (result.availability) {
      lines.push(`- ${result.availability}`);
    }
    if (result.permalink) {
      lines.push(`- ${result.permalink}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Build an isError tool response with a clear message.
 */
function errorResponse(message: string): ToolResponse {
  return {
    content: [{
      type: 'text',
      text: message,
    }],
    isError: true,
  };
}

/**
 * Object-args variant of the tool entry point, matching the raw MCP tool
 * arguments shape ({ query, limit, search_scope }).
 */
export async function searchAppleDocsTool(args: {
  query: string;
  limit?: number;
  search_scope?: string;
}): Promise<ToolResponse> {
  return searchAppleDocs(args.query, args.limit, args.search_scope);
}

/**
 * Tool entry point for search_apple_docs: validate input, call the JSONL
 * search API and format the outcome.
 *
 * Error handling (all return isError=true, never a silent "No results"):
 * - empty/blank query       -> immediate validation error
 * - HTTP 4xx/5xx            -> thrown by the client, wrapped here
 * - network errors/timeouts -> thrown by fetch, wrapped here
 * - JSONL parse failures    -> thrown by the client, wrapped here
 *
 * A stalled stream is *not* an error: whatever was parsed is returned with a
 * partial-results warning unless nothing at all could be recovered.
 */
export async function searchAppleDocs(
  query: string,
  limit: number = 10,
  searchScope: string = '',
): Promise<ToolResponse> {
  const trimmedQuery = (query ?? '').trim();
  if (!trimmedQuery) {
    return errorResponse('query must be a non-empty string');
  }

  try {
    const { results, partial, partialReason } = await searchAppleDocsApiDetailed(
      trimmedQuery,
      limit,
      searchScope,
    );

    if (partial && results.length === 0) {
      return errorResponse(
        `Apple search backend request failed: ${partialReason ?? 'the backend stream stopped before any results arrived'}\n${UNDOCUMENTED_API_NOTE}`,
      );
    }

    return {
      content: [{
        type: 'text',
        text: formatSearchResults(results, trimmedQuery, { partial, partialReason }),
      }],
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return errorResponse(
      `Apple search backend request failed: ${detail}\n${UNDOCUMENTED_API_NOTE}`,
    );
  }
}

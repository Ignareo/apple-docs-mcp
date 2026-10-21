/**
 * Search result formatting and tool entry point for search_apple_docs
 *
 * The search now goes through Apple's JSONL search API (see
 * search-api-client.ts, ported from the verified apple-search-mcp/server.py
 * reference implementation). This module converts the merged API results into
 * the '# Apple Documentation Search Results' markdown the tool has always
 * returned, and wraps the whole call in explicit error handling — the backend
 * is an undocumented Apple interface and may change, so failures must never
 * be silently reported as "no results".
 */

import { searchAppleDocsApi } from './search-api-client.js';
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

/**
 * Format merged search results as markdown, matching the reference output:
 * numbered entries with hierarchy/description/availability/permalink lines.
 */
export function formatSearchResults(results: AppleSearchApiResult[], query: string): string {
  if (results.length === 0) {
    return `# Apple Documentation Search Results\n\n**Query:** "${query}"\n\nNo results.`;
  }

  const lines: string[] = [
    `# Apple Documentation Search Results\n\n**Query:** "${query}"  |  **Results:** ${results.length}\n`,
  ];

  results.forEach((result, index) => {
    lines.push(`### ${index + 1}. ${result.title}`);
    if (result.hierarchy) {
      lines.push(`- Hierarchy: ${result.hierarchy}`);
    }
    if (result.description) {
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
 * - HTTP 4xx/5xx            -> thrown by postQuery, wrapped here
 * - network errors/timeouts -> thrown by fetch, wrapped here
 * - JSONL parse failures    -> thrown by parseJsonl, wrapped here
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
    const results = await searchAppleDocsApi(trimmedQuery, limit, searchScope);
    return {
      content: [{
        type: 'text',
        text: formatSearchResults(results, trimmedQuery),
      }],
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return errorResponse(
      `Apple search backend request failed: ${detail}\n${UNDOCUMENTED_API_NOTE}`,
    );
  }
}

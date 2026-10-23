import { z } from 'zod';

/** Supported Apple search-scope values (mapped to Apple's scope-object DSL). */
export const SEARCH_SCOPE_VALUES = ['', 'documentation', 'video', 'sample_code', 'wwdc26'] as const;

export const searchAppleDocsSchema = z.object({
  query: z.string().trim().min(1, 'query must be a non-empty string')
    .describe('Search query for Apple Developer Documentation'),
  // Apple's backend caps out at ~20 results per query and rejects any limit
  // field, so asking for more than 20 only misleads the caller.
  limit: z.number().int().min(1).max(20).default(10)
    .describe("Max results to return (1-20, default 10; Apple's backend returns at most ~20)"),
  search_scope: z.enum(SEARCH_SCOPE_VALUES).default('')
    .describe("Optional content-type filter: '' (all), 'documentation', 'video', 'sample_code' or 'wwdc26'. Framework filtering is not supported by the backend."),
});

import { z } from 'zod';

export const searchAppleDocsSchema = z.object({
  query: z.string().trim().min(1, 'query must be a non-empty string')
    .describe('Search query for Apple Developer Documentation'),
  limit: z.number().int().min(1).max(30).default(10)
    .describe('Max results to return (default 10)'),
  search_scope: z.string().default('')
    .describe('Optional Apple search scope filter (pass-through; empty = all scopes)'),
});

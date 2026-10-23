import { z } from 'zod';
import { API_LIMITS } from '../utils/constants.js';

/**
 * How `get_documentation_updates` resolves its result.
 *
 * - `auto`     — timeline when a `technology` is given, otherwise the legacy index
 * - `index`    — legacy alphabetical index of update pages (no dates)
 * - `timeline` — dated "what changed" timeline for one technology
 */
export const DOCUMENTATION_UPDATES_DETAIL_VALUES = ['auto', 'index', 'timeline'] as const;

export type DocumentationUpdatesDetail = typeof DOCUMENTATION_UPDATES_DETAIL_VALUES[number];

export const getDocumentationUpdatesSchema = z.object({
  category: z.enum(['all', 'wwdc', 'technology', 'release-notes']).default('all').describe('Filter by update category'),
  technology: z.string().optional().describe('Filter by specific technology/framework name'),
  year: z.string().optional().describe('Filter WWDC by year (e.g., 2025, 2024)'),
  searchQuery: z.string().optional().describe('Search for specific keywords in updates'),
  includeBeta: z.boolean().default(true).describe('Include beta features'),
  limit: z.number().min(1).max(API_LIMITS.MAX_DOCUMENTATION_UPDATES_LIMIT).default(API_LIMITS.DEFAULT_DOCUMENTATION_UPDATES_LIMIT).describe('Maximum number of results to return'),
  detail: z.enum(DOCUMENTATION_UPDATES_DETAIL_VALUES).default('auto')
    .describe("Detail mode: 'auto' (timeline when technology is given, else index), 'index' (legacy link directory) or 'timeline' (dated changes for one technology)"),
});

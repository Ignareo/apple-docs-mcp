/**
 * Framework preloader for performance optimization
 *
 * Only the raw framework index JSON is preloaded. It is cached under the same
 * key the live `search_framework_symbols` tool uses, so a preloaded framework
 * makes every later query (any symbolType/namePattern/language/limit) a pure
 * in-memory traversal.
 */

import {
  getFrameworkIndexCacheKey,
  getFrameworkIndexUrl,
  preloadFrameworkIndex,
} from '../tools/search-framework-symbols.js';
import { indexCache } from './cache.js';
import { logger } from './logger.js';
import { normalizeFrameworkName, getFrameworksByCategory } from './framework-mapper.js';

/**
 * Popular frameworks to preload (using normalized names)
 */
const POPULAR_FRAMEWORKS = [
  ...getFrameworksByCategory('UI'), // SwiftUI, UIKit, etc.
  ...getFrameworksByCategory('Foundation'), // Foundation, Combine, Swift
  ...getFrameworksByCategory('Data').slice(0, 2), // Core Data, CloudKit
  ...getFrameworksByCategory('Graphics').slice(0, 2), // Core Graphics, Metal
  ...getFrameworksByCategory('Games').slice(0, 3), // ARKit, SceneKit, SpriteKit
].map(f => f.toLowerCase());

/** Small default so background warming does not compete with foreground calls. */
const DEFAULT_PRELOAD_CONCURRENCY = 2;

/**
 * Read a positive integer from the environment, falling back to a default.
 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Preloading can be disabled with `APPLE_DOCS_PRELOAD_ENABLED=false`
 * (useful for tests and for users on very slow networks).
 */
function isPreloadEnabled(): boolean {
  return process.env.APPLE_DOCS_PRELOAD_ENABLED !== 'false';
}

function getPreloadConcurrency(): number {
  return readPositiveIntEnv('APPLE_DOCS_PRELOAD_CONCURRENCY', DEFAULT_PRELOAD_CONCURRENCY);
}

function getPreloadStartDelayMs(): number {
  return readPositiveIntEnv('APPLE_DOCS_PRELOAD_DELAY_MS', 0);
}

/**
 * Run a worker over items with bounded concurrency.
 *
 * Workers are expected to handle their own errors so one failure never aborts
 * the rest of the warm-up.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));

  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });

  await Promise.all(runners);
}

/**
 * Whether the raw index for a framework is already cached.
 * Uses the exact same key as `search_framework_symbols`.
 */
function isFrameworkIndexCached(framework: string): boolean {
  return indexCache.has(getFrameworkIndexCacheKey(getFrameworkIndexUrl(framework)));
}

/**
 * Preload popular framework indexes
 */
export async function preloadPopularFrameworks(): Promise<void> {
  if (!isPreloadEnabled()) {
    logger.info('Framework preload disabled (APPLE_DOCS_PRELOAD_ENABLED=false)');
    return;
  }

  const startDelay = getPreloadStartDelayMs();
  if (startDelay > 0) {
    await new Promise(resolve => setTimeout(resolve, startDelay));
  }

  const concurrency = getPreloadConcurrency();
  logger.info(`Starting framework preload (concurrency ${concurrency})...`);

  await runWithConcurrency(POPULAR_FRAMEWORKS, concurrency, async (framework) => {
    try {
      if (isFrameworkIndexCached(framework)) {
        logger.debug(`Framework ${framework} already cached, skipping...`);
        return;
      }

      logger.info(`Preloading framework: ${framework}`);
      await preloadFrameworkIndex(framework);
      logger.info(`Successfully preloaded: ${framework}`);
    } catch (error) {
      // Never let a background warm-up failure affect server startup.
      logger.error(`Failed to preload ${framework}:`, error);
    }
  });

  logger.info('Framework preload completed');
}

/**
 * Preload specific frameworks based on user patterns
 */
export async function preloadFrameworksByUsage(
  recentFrameworks: string[],
): Promise<void> {
  if (!isPreloadEnabled()) {
    return;
  }

  // Normalize framework names and filter out popular ones
  const frameworksToPreload = recentFrameworks
    .map(f => normalizeFrameworkName(f))
    .filter(f => f && !POPULAR_FRAMEWORKS.includes(f.toLowerCase()))
    .map(f => f.toLowerCase());

  if (frameworksToPreload.length === 0) {
    return;
  }

  logger.info(`Preloading ${frameworksToPreload.length} user-specific frameworks...`);

  await runWithConcurrency(frameworksToPreload, getPreloadConcurrency(), async (framework) => {
    try {
      await preloadFrameworkIndex(framework);
      logger.info(`Preloaded user framework: ${framework}`);
    } catch (error) {
      logger.error(`Failed to preload user framework ${framework}:`, error);
    }
  });
}

/**
 * Get preload statistics
 */
export function getPreloadStats(): {
  preloadedFrameworks: string[];
  totalCached: number;
  cacheHitRate: string;
  } {
  const stats = indexCache.getStats();
  const preloadedFrameworks = POPULAR_FRAMEWORKS.filter(isFrameworkIndexCached);

  return {
    preloadedFrameworks,
    totalCached: stats.size,
    cacheHitRate: stats.hitRate,
  };
}

#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { searchAppleDocs as runSearchAppleDocs } from './tools/search-parser.js';
import { fetchAppleDocJson } from './tools/doc-fetcher.js';
import { handleListTechnologies } from './tools/list-technologies.js';
import { searchFrameworkSymbols } from './tools/search-framework-symbols.js';
import { toolDefinitions } from './tools/definitions.js';
import { handleToolCall } from './tools/handlers.js';
import { handleGetRelatedApis } from './tools/get-related-apis.js';
import { handleResolveReferencesBatch } from './tools/resolve-references-batch.js';
import { handleGetPlatformCompatibility } from './tools/get-platform-compatibility.js';
import { handleFindSimilarApis } from './tools/find-similar-apis.js';
import { handleGetDocumentationUpdates } from './tools/get-documentation-updates.js';
import { handleGetTechnologyOverviews } from './tools/get-technology-overviews.js';
import { handleGetSampleCode } from './tools/get-sample-code.js';
import { isValidAppleDeveloperUrl } from './utils/url-converter.js';
import { validateInput, ErrorType, createStandardErrorResponse, createToolErrorResponse, describeError } from './utils/error-handler.js';
import { preloadPopularFrameworks } from './utils/preloader.js';
import { warmUpCaches, schedulePeriodicCacheRefresh } from './utils/cache-warmer.js';
import { logger } from './utils/logger.js';
import { API_LIMITS } from './utils/constants.js';

export default class AppleDeveloperDocsMCPServer {
  private server: Server;

  /**
   * Whether a tool's plain-text result represents a failure.
   *
   * Tool implementations signal failures by returning an "Error: ..." string;
   * checking the prefix lets the protocol response be marked accordingly.
   */
  private looksLikeErrorText(text: unknown): boolean {
    return typeof text === 'string' && text.startsWith('Error:');
  }

  /**
   * Wrap a tool's plain-text result into an MCP text response, setting
   * `isError` when the text starts with "Error:".
   */
  private wrapToolText(text: string): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return {
      content: [{ type: 'text' as const, text }],
      ...(this.looksLikeErrorText(text) ? { isError: true } : {}),
    };
  }

  /**
   * Mark an already-built response as an error when its first text block
   * starts with "Error:" and `isError` was not set by the handler.
   */
  private normalizeTextResponse<T extends { content?: Array<{ type: string; text: string }>; isError?: boolean }>(
    response: T,
  ): T {
    if (!response || !Array.isArray(response.content) || response.isError === true) {
      return response;
    }
    const firstText = response.content.find(block => block.type === 'text');
    if (this.looksLikeErrorText(firstText?.text)) {
      return { ...response, isError: true };
    }
    return response;
  }

  /**
   * Helper method to handle async operations with consistent error handling
   */
  private async handleAsyncOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      const result = await operation();
      return this.wrapToolText(result as string);
    } catch (error) {
      // If error is already an AppError, use tool-specific suggestions
      if (error && typeof error === 'object' && 'type' in error) {
        return createToolErrorResponse(error as any, operationName);
      }
      return createStandardErrorResponse(error, operationName);
    }
  }

  constructor() {
    this.server = new Server(
      {
        name: 'apple-docs-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupTools();
    this.setupErrorHandling();
  }

  private setupTools() {
    // const cacheStatsSchema = z.object({});

    // 处理工具列表请求
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolDefinitions,
      };
    });

    // 处理工具调用请求
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        return this.normalizeTextResponse(await handleToolCall(name, args, this));
      } catch (error) {
        // Zod schema validation failures (e.g. limit out of range) would
        // otherwise dump a raw multi-issue ZodError JSON array on the caller.
        // Surface only the first issue in a readable one-liner instead.
        if (error instanceof ZodError) {
          const issue = error.issues[0];
          const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'arguments';
          return {
            content: [
              {
                type: 'text',
                text: `Invalid arguments for ${name}: ${where}: ${issue?.message ?? error.message}`,
              },
            ],
            isError: true,
          };
        }

        // Use the actual message when the thrown value carries one; otherwise
        // keep the generic message (e.g. for a bare string rejection).
        const carriesMessage =
          !!error &&
          typeof error === 'object' &&
          typeof (error as { message?: unknown }).message === 'string' &&
          (error as { message: string }).message.trim() !== '';
        const appError = {
          type: 'UNKNOWN' as const,
          message: carriesMessage ? describeError(error) : 'An unknown error occurred',
          originalError: error instanceof Error ? error : undefined,
        };

        logger.error(`Tool ${name} failed:`, appError);

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${appError.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  public async searchAppleDocs(
    query: string,
    limit: number = 10,
    searchScope: string = '',
    locale: string = 'en-US',
  ) {
    // 输入验证
    const queryValidation = validateInput(query, 'Search query');
    if (queryValidation) {
      return createToolErrorResponse(queryValidation, 'search_apple_docs');
    }

    logger.info(`Searching Apple docs for: ${query}`);

    // search-parser 内部已包含显式错误处理（isError），直接透传其结果
    return runSearchAppleDocs(query, limit, searchScope, locale);
  }

  public async getAppleDocContent(
    url: string,
    includeRelatedApis: boolean = false,
    includeReferences: boolean = false,
    includeSimilarApis: boolean = false,
    includePlatformAnalysis: boolean = false,
  ) {
    try {
      // 输入验证
      const urlValidation = validateInput(url, 'URL');
      if (urlValidation) {
        return createToolErrorResponse(urlValidation, 'get_apple_doc_content');
      }

      // 验证是否为有效的Apple Developer URL
      if (!isValidAppleDeveloperUrl(url)) {
        return createToolErrorResponse({
          type: ErrorType.INVALID_INPUT,
          message: 'URL must be from developer.apple.com',
        }, 'get_apple_doc_content');
      }

      // fetchAppleDocJson 已经返回正确的MCP响应格式，直接返回
      return await fetchAppleDocJson(url, {
        includeRelatedApis,
        includeReferences,
        includeSimilarApis,
        includePlatformAnalysis,
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'type' in error) {
        return createToolErrorResponse(error as any, 'get_apple_doc_content');
      }
      return createStandardErrorResponse(error, 'get_apple_doc_content');
    }
  }

  public async listTechnologies(
    category?: string,
    language?: string,
    includeBeta: boolean = true,
    limit: number = API_LIMITS.DEFAULT_TECHNOLOGIES_LIMIT,
  ) {
    return this.handleAsyncOperation(
      () => handleListTechnologies(category, language, includeBeta, limit),
      'listTechnologies',
    );
  }

  public async searchFrameworkSymbols(framework: string, symbolType: string = 'all', namePattern?: string, language: string = 'swift', limit: number = API_LIMITS.DEFAULT_FRAMEWORK_SYMBOLS_LIMIT) {
    return this.handleAsyncOperation(
      () => searchFrameworkSymbols(framework, symbolType, namePattern, language, limit),
      'searchFrameworkSymbols',
    );
  }

  public async getRelatedApis(
    apiUrl: string,
    includeInherited: boolean = true,
    includeConformance: boolean = true,
    includeSeeAlso: boolean = true,
  ) {
    return this.handleAsyncOperation(
      () => handleGetRelatedApis(apiUrl, includeInherited, includeConformance, includeSeeAlso),
      'getRelatedApis',
    );
  }

  public async resolveReferencesBatch(sourceUrl: string, maxReferences: number = API_LIMITS.DEFAULT_REFERENCES_LIMIT, filterByType: string = 'all') {
    return this.handleAsyncOperation(
      () => handleResolveReferencesBatch(sourceUrl, maxReferences, filterByType),
      'resolveReferencesBatch',
    );
  }

  public async getPlatformCompatibility(apiUrl: string, compareMode: string = 'single', includeRelated: boolean = false) {
    return this.handleAsyncOperation(
      () => handleGetPlatformCompatibility(apiUrl, compareMode, includeRelated),
      'getPlatformCompatibility',
    );
  }

  public async findSimilarApis(
    apiUrl: string,
    searchDepth: string = 'medium',
    filterByCategory?: string,
    includeAlternatives: boolean = true,
  ) {
    return this.handleAsyncOperation(
      () => handleFindSimilarApis(apiUrl, searchDepth, filterByCategory, includeAlternatives),
      'findSimilarApis',
    );
  }

  public async getDocumentationUpdates(
    category: string = 'all',
    technology?: string,
    year?: string,
    searchQuery?: string,
    includeBeta: boolean = true,
    limit: number = API_LIMITS.DEFAULT_DOCUMENTATION_UPDATES_LIMIT,
    detail: 'auto' | 'index' | 'timeline' = 'auto',
  ) {
    return this.handleAsyncOperation(
      () => handleGetDocumentationUpdates(category, technology, year, searchQuery, includeBeta, limit, detail),
      'getDocumentationUpdates',
    );
  }

  public async getTechnologyOverviews(
    category?: string,
    platform: string = 'all',
    searchQuery?: string,
    includeSubcategories: boolean = true,
    limit: number = API_LIMITS.DEFAULT_TECHNOLOGY_OVERVIEWS_LIMIT,
  ) {
    return this.handleAsyncOperation(
      () => handleGetTechnologyOverviews(category, platform, searchQuery, includeSubcategories, limit),
      'getTechnologyOverviews',
    );
  }

  public async getSampleCode(
    framework?: string,
    beta: 'include' | 'exclude' | 'only' = 'include',
    searchQuery?: string,
    limit: number = API_LIMITS.DEFAULT_SAMPLE_CODE_LIMIT,
  ) {
    return this.handleAsyncOperation(
      () => handleGetSampleCode(framework, beta, searchQuery, limit),
      'getSampleCode',
    );
  }

  private setupErrorHandling() {
    // 处理 SIGINT 以优雅关闭服务器
    process.on('SIGINT', () => {
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      process.exit(0);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled Rejection, reason:', reason);
      process.exit(1);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('Apple Developer Docs MCP server running on stdio');
    logger.info('WWDC Data: Using bundled data from npm package');
    logger.info('Cache system initialized with TTL: API(30m), Index(1h), Technologies(2h)');
    logger.info('Note: Search results are not cached to ensure real-time accuracy');

    // Start framework preloading and cache warming in background
    Promise.all([
      preloadPopularFrameworks(),
      warmUpCaches(),
    ]).catch(error => {
      logger.error('Background initialization failed:', error);
    });

    // Schedule periodic cache refresh (every 30 minutes)
    schedulePeriodicCacheRefresh();
  }
}

// Run server (only in non-test environment)
if (process.env.NODE_ENV !== 'test') {
  const server = new AppleDeveloperDocsMCPServer();
  void server.run().catch((error) => {
    logger.error('Fatal error in main():', error);
    process.exit(1);
  });
}
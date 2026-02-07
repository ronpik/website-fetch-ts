import type { LLMProvider, LLMConfig } from './llm/types.js';

/**
 * Raw fetched page data before conversion.
 */
export interface FetchedPageRaw {
  url: string;
  html: string;
  statusCode: number;
  headers: Record<string, string>;
  fetchedAt: Date;
}

/**
 * Fetched page with post-conversion fields (markdown, title, depth).
 */
export interface FetchedPage extends FetchedPageRaw {
  markdown: string;
  title?: string;
  depth: number;
}

/**
 * A page that was skipped during crawling.
 */
export interface SkippedPage {
  url: string;
  reason: string;
}

/**
 * Full configuration interface for website-fetch.
 */
export interface WebsiteFetchConfig {
  // Required
  url: string;

  // Mode
  mode: 'simple' | 'smart' | 'agent';
  description?: string;

  // Scope
  maxDepth: number;
  maxPages: number;
  includePatterns?: string[];
  excludePatterns?: string[];

  // Output
  outputDir: string;
  outputStructure: 'mirror' | 'flat';
  singleFile?: boolean;
  generateIndex: boolean;

  // Conversion
  conversionStrategy: 'default' | 'readability' | 'custom';
  optimizeConversion: boolean;
  customConverter?: (html: string, url: string) => Promise<string>;

  // Fetching
  delay: number;
  concurrency: number;
  respectRobots: boolean;
  adaptiveRateLimit: boolean;
  headers?: Record<string, string>;
  cookieFile?: string;

  // LLM
  llmProvider?: LLMProvider;
  llmConfig?: LLMConfig;
  model?: string;

  // Smart mode
  linkClassification?: 'batch' | 'per-link';

  // Events
  onPageFetched?: (page: FetchedPage) => void;
  onPageSkipped?: (url: string, reason: string) => void;
  onError?: (url: string, error: Error) => void;
}

/**
 * Result returned from a website fetch operation.
 */
export interface FetchResult {
  pages: FetchedPage[];
  skipped: SkippedPage[];
  outputPath: string;
  indexPath?: string;
  singleFilePath?: string;
  stats: {
    totalPages: number;
    totalSkipped: number;
    duration: number;
  };
}

/**
 * Default configuration values. Applied when merging user-provided
 * partial config into a full WebsiteFetchConfig.
 */
export const CONFIG_DEFAULTS: Partial<WebsiteFetchConfig> = {
  mode: 'simple',
  maxDepth: 5,
  maxPages: 100,
  outputDir: './output',
  outputStructure: 'mirror',
  generateIndex: true,
  conversionStrategy: 'default',
  optimizeConversion: false,
  delay: 200,
  concurrency: 3,
  respectRobots: true,
  adaptiveRateLimit: true,
  linkClassification: 'batch',
};

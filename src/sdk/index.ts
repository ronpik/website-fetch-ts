import type {
  WebsiteFetchConfig,
  FetchResult,
} from '../types.js';
import { CONFIG_DEFAULTS } from '../types.js';
import { createFetcher } from '../fetcher/index.js';
import type { Fetcher } from '../fetcher/index.js';
import { createConverter } from '../converter/index.js';
import type { Converter } from '../converter/index.js';
import { createLLMProvider } from '../llm/index.js';
import type { LLMProvider } from '../llm/types.js';
import { createOutputWriter } from '../output/index.js';
import type { OutputWriter } from '../output/index.js';
import { IndexGenerator, createLLMDescriptionProvider } from '../output/index-generator.js';
import { SingleFileWriter } from '../output/single-file.js';
import { SimpleCrawler } from '../crawler/simple.js';
import { SmartCrawler } from '../crawler/smart.js';
import { AgentCrawler } from '../crawler/agent.js';

/**
 * The valid crawl mode values.
 */
const VALID_MODES = ['simple', 'smart', 'agent'] as const;

/**
 * Mode-specific default overrides for conversion settings.
 *
 * | Mode   | conversionStrategy | optimizeConversion |
 * |--------|--------------------|--------------------|
 * | simple | default            | false              |
 * | smart  | readability        | false              |
 * | agent  | readability        | true               |
 */
const MODE_CONVERSION_DEFAULTS: Record<
  'simple' | 'smart' | 'agent',
  { conversionStrategy: 'default' | 'readability'; optimizeConversion: boolean }
> = {
  simple: { conversionStrategy: 'default', optimizeConversion: false },
  smart: { conversionStrategy: 'readability', optimizeConversion: false },
  agent: { conversionStrategy: 'readability', optimizeConversion: true },
};

/**
 * Validate the user-provided config and throw clear errors for invalid inputs.
 *
 * @param userConfig - The partial config provided by the user
 * @throws Error if required fields are missing or invalid
 */
function validateConfig(
  userConfig: Partial<WebsiteFetchConfig> & { url: string },
): void {
  // url is required
  if (!userConfig.url || typeof userConfig.url !== 'string' || userConfig.url.trim() === '') {
    throw new Error('websiteFetch: "url" is required and must be a non-empty string');
  }

  // Validate mode if provided
  const mode = userConfig.mode ?? CONFIG_DEFAULTS.mode ?? 'simple';
  if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
    throw new Error(
      `websiteFetch: Unknown mode "${mode}". Valid modes are: ${VALID_MODES.join(', ')}`,
    );
  }

  // description is required for smart and agent modes
  if (mode === 'smart' || mode === 'agent') {
    if (!userConfig.description || typeof userConfig.description !== 'string' || userConfig.description.trim() === '') {
      throw new Error(
        `websiteFetch: "description" is required when mode is "${mode}". ` +
        'Provide a description of what content to crawl.',
      );
    }
  }
}

/**
 * Merge user config with CONFIG_DEFAULTS and mode-specific conversion defaults.
 *
 * Merge order (later wins):
 * 1. CONFIG_DEFAULTS (base defaults)
 * 2. Mode-specific conversion defaults
 * 3. User-provided values
 *
 * @param userConfig - The partial config provided by the user
 * @returns A fully populated WebsiteFetchConfig
 */
function mergeDefaults(
  userConfig: Partial<WebsiteFetchConfig> & { url: string },
): WebsiteFetchConfig {
  const mode = userConfig.mode ?? (CONFIG_DEFAULTS.mode as 'simple' | 'smart' | 'agent') ?? 'simple';
  const modeDefaults = MODE_CONVERSION_DEFAULTS[mode];

  return {
    ...CONFIG_DEFAULTS,
    ...modeDefaults,
    ...userConfig,
    mode,
  } as WebsiteFetchConfig;
}

/**
 * Validate and merge the user config into a full WebsiteFetchConfig.
 *
 * @param userConfig - The partial config provided by the user
 * @returns A validated, fully populated WebsiteFetchConfig
 */
function validateAndMergeConfig(
  userConfig: Partial<WebsiteFetchConfig> & { url: string },
): WebsiteFetchConfig {
  validateConfig(userConfig);
  return mergeDefaults(userConfig);
}

/**
 * Interface for the crawl method shared by all crawler types.
 */
interface Crawler {
  crawl(): Promise<FetchResult>;
}

/**
 * Create the appropriate crawler based on the configured mode.
 *
 * @param config - The full website-fetch config
 * @param fetcher - The fetcher instance
 * @param converter - The converter instance
 * @param outputWriter - The output writer instance
 * @param llmProvider - The LLM provider (required for smart/agent modes)
 * @returns A crawler instance with a crawl() method
 */
function createCrawler(
  config: WebsiteFetchConfig,
  fetcher: Fetcher,
  converter: Converter,
  outputWriter: OutputWriter,
  llmProvider?: LLMProvider,
): Crawler {
  switch (config.mode) {
    case 'simple':
      return new SimpleCrawler(config, fetcher, converter, outputWriter);

    case 'smart':
      return new SmartCrawler(
        config,
        fetcher,
        converter,
        outputWriter,
        llmProvider!,
        config.description!,
      );

    case 'agent':
      return new AgentCrawler(
        config,
        fetcher,
        converter,
        outputWriter,
        llmProvider!,
        config.description!,
      );

    default: {
      // This should never be reached due to prior validation,
      // but provides exhaustiveness checking.
      const _exhaustive: never = config.mode;
      throw new Error(`Unknown mode: ${_exhaustive}`);
    }
  }
}

/**
 * Generate an index file for the crawled pages.
 *
 * Uses the IndexGenerator with an optional LLM description provider
 * when an LLM provider is available.
 *
 * @param pages - The fetched pages to index
 * @param config - The full config
 * @param llmProvider - Optional LLM provider for generating page descriptions
 * @returns The path to the generated index file
 */
async function generateIndex(
  pages: FetchResult['pages'],
  config: WebsiteFetchConfig,
  llmProvider?: LLMProvider,
): Promise<string> {
  const generator = new IndexGenerator();
  const descriptionProvider = llmProvider
    ? createLLMDescriptionProvider(llmProvider)
    : undefined;

  return generator.generate(
    pages,
    config.outputDir,
    config.outputStructure,
    descriptionProvider,
  );
}

/**
 * Write all pages to a single aggregated file.
 *
 * @param pages - The fetched pages to aggregate
 * @param config - The full config
 * @returns The path to the generated single file
 */
async function writeSingleFile(
  pages: FetchResult['pages'],
  config: WebsiteFetchConfig,
): Promise<string> {
  const writer = new SingleFileWriter();
  return writer.write(pages, config.outputDir, config.url);
}

/**
 * Fetch and convert website content to markdown.
 *
 * This is the main SDK entry point. It validates the configuration,
 * creates all required components (fetcher, converter, LLM provider,
 * output writer), selects the appropriate crawler mode, runs the crawl,
 * and optionally generates an index file and single-file output.
 *
 * @param userConfig - Partial config with at least `url` specified.
 *   All other fields have sensible defaults. For smart/agent modes,
 *   `description` is also required.
 * @returns The crawl result including pages, skipped pages, output paths, and stats
 *
 * @example
 * ```typescript
 * // Simple mode - just provide a URL
 * const result = await websiteFetch({ url: 'https://example.com' });
 *
 * // Smart mode - requires a description
 * const result = await websiteFetch({
 *   url: 'https://docs.example.com',
 *   mode: 'smart',
 *   description: 'API reference documentation',
 * });
 * ```
 */
export async function websiteFetch(
  userConfig: Partial<WebsiteFetchConfig> & { url: string },
): Promise<FetchResult> {
  const config = validateAndMergeConfig(userConfig);

  const fetcher = createFetcher(config);
  const llmProvider = config.mode !== 'simple'
    ? (config.llmProvider ?? createLLMProvider(config.llmConfig))
    : undefined;
  if (llmProvider) {
    config.llmProvider = llmProvider;
  }
  const converter = createConverter(config);
  const outputWriter = createOutputWriter(config);

  try {
    const crawler = createCrawler(config, fetcher, converter, outputWriter, llmProvider);
    const result = await crawler.crawl();

    if (config.generateIndex) {
      result.indexPath = await generateIndex(result.pages, config, llmProvider);
    }

    if (config.singleFile) {
      result.singleFilePath = await writeSingleFile(result.pages, config);
    }

    return result;
  } finally {
    fetcher.close();
  }
}

// Default export
export default websiteFetch;

// Re-export building blocks for advanced usage
export { createFetcher } from '../fetcher/index.js';
export type { Fetcher } from '../fetcher/index.js';
export { createConverter } from '../converter/index.js';
export type { Converter } from '../converter/index.js';
export { createLLMProvider } from '../llm/index.js';
export type { LLMProvider } from '../llm/types.js';
export { createOutputWriter } from '../output/index.js';
export type { OutputWriter } from '../output/index.js';
export { SimpleCrawler } from '../crawler/simple.js';
export { SmartCrawler } from '../crawler/smart.js';
export { AgentCrawler } from '../crawler/agent.js';
export { IndexGenerator } from '../output/index-generator.js';
export { SingleFileWriter } from '../output/single-file.js';
export { CONFIG_DEFAULTS } from '../types.js';
export type { WebsiteFetchConfig, FetchResult, FetchedPage, SkippedPage } from '../types.js';

// Export internal helpers for testing
export { validateAndMergeConfig, createCrawler, generateIndex, writeSingleFile };

import { readFileSync } from 'node:fs';
import type { WebsiteFetchConfig } from '../types.js';
import type { LLMConfig } from '../llm/types.js';

/**
 * Raw CLI options as parsed by commander.
 */
export interface CLIOptions {
  mode: string;
  description?: string;
  depth?: string;
  maxPages?: string;
  include?: string[];
  exclude?: string[];
  output: string;
  flat?: boolean;
  singleFile?: boolean;
  index?: boolean;
  conversion?: string;
  optimizeConversion?: boolean;
  delay?: string;
  concurrency?: string;
  ignoreRobots?: boolean;
  header?: string[];
  cookieFile?: string;
  llmConfig?: string;
  model?: string;
  provider?: string;
  linkClassification?: string;
  verbose?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
}

/**
 * Parse --header values from "key:value" format into a Record.
 * Splits on the first colon to allow colons in the value.
 *
 * @param headers - Array of "key:value" strings
 * @returns A Record mapping header names to values
 * @throws Error if a header value does not contain a colon
 */
export function parseHeaders(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const header of headers) {
    const colonIndex = header.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(
        `Invalid header format: "${header}". Expected "key:value" format.`,
      );
    }
    const key = header.slice(0, colonIndex).trim();
    const value = header.slice(colonIndex + 1).trim();
    if (!key) {
      throw new Error(
        `Invalid header format: "${header}". Header name cannot be empty.`,
      );
    }
    result[key] = value;
  }

  return result;
}

/**
 * Load and parse an LLM config JSON file.
 *
 * @param filePath - Path to the LLM config JSON file
 * @returns The parsed LLMConfig
 * @throws Error if the file cannot be read or parsed
 */
export function loadLLMConfig(filePath: string): LLMConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Cannot read LLM config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return JSON.parse(content) as LLMConfig;
  } catch (error) {
    throw new Error(
      `Invalid JSON in LLM config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build a WebsiteFetchConfig from the parsed CLI options and URL argument.
 *
 * Maps commander option names to the WebsiteFetchConfig property names.
 * Only sets properties that were explicitly provided by the user;
 * the SDK's own default merging handles the rest.
 *
 * @param url - The positional URL argument
 * @param options - The parsed commander options
 * @returns A partial WebsiteFetchConfig with at least `url` set
 */
export function buildConfig(
  url: string,
  options: CLIOptions,
): Partial<WebsiteFetchConfig> & { url: string } {
  const config: Partial<WebsiteFetchConfig> & { url: string } = { url };

  // Mode
  if (options.mode) {
    config.mode = options.mode as WebsiteFetchConfig['mode'];
  }
  if (options.description !== undefined) {
    config.description = options.description;
  }

  // Scope
  if (options.depth !== undefined) {
    config.maxDepth = parseInt(options.depth, 10);
  }
  if (options.maxPages !== undefined) {
    config.maxPages = parseInt(options.maxPages, 10);
  }
  if (options.include !== undefined && options.include.length > 0) {
    config.includePatterns = options.include;
  }
  if (options.exclude !== undefined && options.exclude.length > 0) {
    config.excludePatterns = options.exclude;
  }

  // Output
  if (options.output) {
    config.outputDir = options.output;
  }
  if (options.flat) {
    config.outputStructure = 'flat';
  }
  if (options.singleFile) {
    config.singleFile = true;
  }
  // Commander negated option: --no-index sets options.index to false
  if (options.index === false) {
    config.generateIndex = false;
  }

  // Conversion
  if (options.conversion !== undefined) {
    config.conversionStrategy = options.conversion as WebsiteFetchConfig['conversionStrategy'];
  }
  if (options.optimizeConversion !== undefined) {
    config.optimizeConversion = options.optimizeConversion;
  }

  // Fetching
  if (options.delay !== undefined) {
    config.delay = parseInt(options.delay, 10);
  }
  if (options.concurrency !== undefined) {
    config.concurrency = parseInt(options.concurrency, 10);
  }
  if (options.ignoreRobots) {
    config.respectRobots = false;
  }
  if (options.header !== undefined && options.header.length > 0) {
    config.headers = parseHeaders(options.header);
  }
  if (options.cookieFile !== undefined) {
    config.cookieFile = options.cookieFile;
  }

  // LLM
  if (options.llmConfig !== undefined) {
    config.llmConfig = loadLLMConfig(options.llmConfig);
  }
  if (options.model !== undefined) {
    config.model = options.model;
  }
  // provider: override provider in llmConfig defaults
  if (options.provider !== undefined) {
    if (!config.llmConfig) {
      config.llmConfig = {
        defaults: {
          provider: options.provider,
          model: config.model ?? 'claude-3-5-haiku-latest',
        },
      };
    } else {
      config.llmConfig.defaults.provider = options.provider;
    }
  }

  // Smart mode
  if (options.linkClassification !== undefined) {
    config.linkClassification = options.linkClassification as WebsiteFetchConfig['linkClassification'];
  }

  return config;
}

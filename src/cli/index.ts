import { Command } from 'commander';
import { websiteFetch } from '../sdk/index.js';
import { CONFIG_DEFAULTS } from '../types.js';
import { buildConfig } from './options.js';
import type { CLIOptions } from './options.js';
import {
  createProgressCallbacks,
  printSummary,
  printDryRun,
  type Verbosity,
} from './progress.js';

/**
 * Accumulate repeated option values into an array.
 * Used for --header, --include, --exclude which can be specified multiple times.
 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Create and configure the commander program with all CLI options.
 *
 * @returns The configured Command instance
 */
function createProgram(): Command {
  const program = new Command();

  program
    .name('website-fetch')
    .description('Fetch and convert website content to markdown')
    .version('0.1.0')
    .argument('<url>', 'Root URL to crawl')

    // Mode
    .option('-m, --mode <mode>', 'Crawl mode: simple, smart, or agent', 'simple')
    .option('-d, --description <text>', 'What to fetch (required for smart/agent)')

    // Scope
    .option('--depth <n>', 'Max crawl depth', String(CONFIG_DEFAULTS.maxDepth))
    .option('--max-pages <n>', 'Max pages to fetch', String(CONFIG_DEFAULTS.maxPages))
    .option('--include <pattern>', 'URL patterns to include (repeatable)', collect, [])
    .option('--exclude <pattern>', 'URL patterns to exclude (repeatable)', collect, [])
    .option('--prefix <path>', 'Only follow links under this URL path prefix (path or full URL)')

    // Output
    .option('-o, --output <dir>', 'Output directory', CONFIG_DEFAULTS.outputDir)
    .option('--flat', 'Flat file structure instead of mirror')
    .option('--single-file', 'Also generate single aggregated file')
    .option('--no-index', 'Skip index file generation')

    // Conversion
    .option('--conversion <strategy>', 'Conversion strategy: default, readability, or custom')
    .option('--optimize-conversion', 'Enable LLM conversion optimization loop')
    .option('--no-optimize-conversion', 'Disable LLM conversion optimization loop')

    // Fetching
    .option('--delay <ms>', 'Delay between requests in ms', String(CONFIG_DEFAULTS.delay))
    .option('--concurrency <n>', 'Parallel requests', String(CONFIG_DEFAULTS.concurrency))
    .option('--ignore-robots', 'Ignore robots.txt')
    .option('--header <key:value>', 'Custom header (repeatable)', collect, [])
    .option('--cookie-file <path>', 'Path to cookie file')

    // LLM
    .option('--llm-config <path>', 'Path to LLM config JSON file')
    .option('--model <model>', 'Override default model')
    .option('--provider <provider>', 'Override default provider')

    // Smart mode
    .option('--link-classification <strategy>', 'Link classification: batch or per-link')

    // General
    .option('-v, --verbose', 'Verbose logging')
    .option('-q, --quiet', 'Suppress output except errors')
    .option('--dry-run', 'Show what would be fetched without fetching');

  return program;
}

/**
 * Determine the verbosity level from CLI flags.
 *
 * @param options - The parsed CLI options
 * @returns The verbosity level
 */
function getVerbosity(options: CLIOptions): Verbosity {
  if (options.quiet) return 'quiet';
  if (options.verbose) return 'verbose';
  return 'normal';
}

/**
 * Validate mode-specific requirements before calling the SDK.
 * Provides user-friendly error messages at the CLI level.
 *
 * @param options - The parsed CLI options
 * @throws Error if validation fails
 */
function validateCLIOptions(options: CLIOptions): void {
  const validModes = ['simple', 'smart', 'agent'];
  if (!validModes.includes(options.mode)) {
    throw new Error(
      `Invalid mode "${options.mode}". Must be one of: ${validModes.join(', ')}`,
    );
  }

  if ((options.mode === 'smart' || options.mode === 'agent') && !options.description) {
    throw new Error(
      `The --description option is required when using "${options.mode}" mode.`,
    );
  }

  if (options.verbose && options.quiet) {
    throw new Error('Cannot use --verbose and --quiet at the same time.');
  }

  if (options.conversion !== undefined) {
    const validStrategies = ['default', 'readability', 'custom'];
    if (!validStrategies.includes(options.conversion)) {
      throw new Error(
        `Invalid conversion strategy "${options.conversion}". Must be one of: ${validStrategies.join(', ')}`,
      );
    }
  }

  if (options.linkClassification !== undefined) {
    const validClassifications = ['batch', 'per-link'];
    if (!validClassifications.includes(options.linkClassification)) {
      throw new Error(
        `Invalid link classification "${options.linkClassification}". Must be one of: ${validClassifications.join(', ')}`,
      );
    }
  }
}

/**
 * Main CLI entry point. Parses command-line arguments, builds
 * configuration, and invokes the SDK's websiteFetch() function.
 *
 * @param argv - The process.argv array to parse
 */
export async function run(argv: string[]): Promise<void> {
  const program = createProgram();

  program.action(async (url: string, options: CLIOptions) => {
    try {
      // Validate CLI-specific constraints
      validateCLIOptions(options);

      const verbosity = getVerbosity(options);

      // Build the SDK config from CLI options
      const config = buildConfig(url, options);

      // Handle dry-run mode
      if (options.dryRun) {
        const mergedMode = config.mode ?? 'simple';
        printDryRun(url, {
          mode: mergedMode,
          maxDepth: config.maxDepth ?? CONFIG_DEFAULTS.maxDepth!,
          maxPages: config.maxPages ?? CONFIG_DEFAULTS.maxPages!,
          outputDir: config.outputDir ?? CONFIG_DEFAULTS.outputDir!,
          respectRobots: config.respectRobots ?? CONFIG_DEFAULTS.respectRobots!,
          description: config.description,
          includePatterns: config.includePatterns,
          excludePatterns: config.excludePatterns,
          pathPrefix: config.pathPrefix,
        });
        process.exit(0);
      }

      // Attach progress callbacks
      const callbacks = createProgressCallbacks(verbosity);
      config.onPageFetched = callbacks.onPageFetched;
      config.onPageSkipped = callbacks.onPageSkipped;
      config.onError = callbacks.onError;

      // Run the crawl
      const result = await websiteFetch(config);

      // Print summary
      printSummary(result, verbosity);

      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  });

  program.parse(argv);
}

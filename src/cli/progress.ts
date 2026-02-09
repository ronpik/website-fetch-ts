import type { FetchedPage, FetchResult } from '../types.js';

/**
 * Output verbosity level for the CLI.
 */
export type Verbosity = 'normal' | 'verbose' | 'quiet';

/**
 * Create event callback handlers for progress display during crawling.
 *
 * Returns `onPageFetched` and `onPageSkipped` callbacks that write
 * progress to stderr so they don't interfere with stdout output.
 *
 * - quiet mode: no output
 * - normal mode: page count and URL for each fetched page
 * - verbose mode: page count, URL, status code, and content length
 *
 * @param verbosity - The desired output verbosity
 * @returns An object with onPageFetched and onPageSkipped callbacks
 */
export function createProgressCallbacks(verbosity: Verbosity): {
  onPageFetched: (page: FetchedPage) => void;
  onPageSkipped: (url: string, reason: string) => void;
  onError: (url: string, error: Error) => void;
} {
  let fetchedCount = 0;
  let skippedCount = 0;

  if (verbosity === 'quiet') {
    return {
      onPageFetched: () => { fetchedCount++; },
      onPageSkipped: () => { skippedCount++; },
      onError: () => {},
    };
  }

  return {
    onPageFetched: (page: FetchedPage) => {
      fetchedCount++;
      if (verbosity === 'verbose') {
        process.stderr.write(
          `[${fetchedCount}] Fetched: ${page.url} (${page.statusCode}, ${page.markdown.length} chars)\n`,
        );
      } else {
        process.stderr.write(
          `[${fetchedCount}] ${page.url}\n`,
        );
      }
    },

    onPageSkipped: (url: string, reason: string) => {
      skippedCount++;
      if (verbosity === 'verbose') {
        process.stderr.write(
          `  Skipped: ${url} (${reason})\n`,
        );
      }
    },

    onError: (url: string, error: Error) => {
      process.stderr.write(
        `  Error: ${url} - ${error.message}\n`,
      );
    },
  };
}

/**
 * Print a summary of the crawl results to stderr.
 *
 * @param result - The fetch result to summarize
 * @param verbosity - The desired output verbosity
 */
export function printSummary(result: FetchResult, verbosity: Verbosity): void {
  if (verbosity === 'quiet') {
    return;
  }

  const durationSec = (result.stats.duration / 1000).toFixed(1);

  process.stderr.write('\n');
  process.stderr.write(`Done! Fetched ${result.stats.totalPages} pages`);
  if (result.stats.totalSkipped > 0) {
    process.stderr.write(`, skipped ${result.stats.totalSkipped}`);
  }
  process.stderr.write(` in ${durationSec}s\n`);
  process.stderr.write(`Output: ${result.outputPath}\n`);

  if (result.indexPath) {
    process.stderr.write(`Index: ${result.indexPath}\n`);
  }
  if (result.singleFilePath) {
    process.stderr.write(`Single file: ${result.singleFilePath}\n`);
  }
}

/**
 * Print dry-run information showing what would be fetched.
 *
 * @param url - The root URL
 * @param config - Key configuration values to display
 */
export function printDryRun(
  url: string,
  config: {
    mode: string;
    maxDepth: number;
    maxPages: number;
    outputDir: string;
    respectRobots: boolean;
    description?: string;
    includePatterns?: string[];
    excludePatterns?: string[];
    pathPrefix?: string;
  },
): void {
  process.stderr.write('\n--- Dry Run ---\n');
  process.stderr.write(`URL: ${url}\n`);
  process.stderr.write(`Mode: ${config.mode}\n`);
  if (config.description) {
    process.stderr.write(`Description: ${config.description}\n`);
  }
  process.stderr.write(`Max depth: ${config.maxDepth}\n`);
  process.stderr.write(`Max pages: ${config.maxPages}\n`);
  process.stderr.write(`Output: ${config.outputDir}\n`);
  process.stderr.write(`Respect robots.txt: ${config.respectRobots}\n`);
  if (config.includePatterns && config.includePatterns.length > 0) {
    process.stderr.write(`Include patterns: ${config.includePatterns.join(', ')}\n`);
  }
  if (config.excludePatterns && config.excludePatterns.length > 0) {
    process.stderr.write(`Exclude patterns: ${config.excludePatterns.join(', ')}\n`);
  }
  if (config.pathPrefix) {
    process.stderr.write(`Path prefix: ${config.pathPrefix}\n`);
  }
  process.stderr.write('--- No pages will be fetched ---\n');
}

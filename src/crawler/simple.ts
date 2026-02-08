import type {
  WebsiteFetchConfig,
  FetchedPage,
  SkippedPage,
  FetchResult,
} from '../types.js';
import type { Fetcher } from '../fetcher/index.js';
import type { Converter } from '../converter/index.js';
import type { OutputWriter } from '../output/index.js';
import { extractLinks } from '../fetcher/link-extractor.js';
import { normalizeUrl, VisitedSet, buildFetchResult } from './base.js';

/** An item in the BFS queue. */
interface QueueItem {
  url: string;
  depth: number;
}

/**
 * Simple BFS crawler that visits all same-domain pages matching
 * configured include/exclude patterns.
 *
 * No LLM is involved; link selection is purely rule-based
 * (domain match, include/exclude patterns, depth limit, page cap).
 *
 * Pages are written to output as they are fetched (streaming).
 */
export class SimpleCrawler {
  private visited = new VisitedSet();
  private queue: QueueItem[] = [];
  private pages: FetchedPage[] = [];
  private skipped: SkippedPage[] = [];

  constructor(
    private config: WebsiteFetchConfig,
    private fetcher: Fetcher,
    private converter: Converter,
    private outputWriter: OutputWriter,
  ) {}

  /**
   * Run the BFS crawl starting from the configured root URL.
   *
   * @returns The crawl result including pages, skipped pages, and stats
   */
  async crawl(): Promise<FetchResult> {
    const startTime = Date.now();

    // Seed the queue with the root URL at depth 0
    this.queue.push({ url: this.config.url, depth: 0 });

    while (this.queue.length > 0 && this.pages.length < this.config.maxPages) {
      const item = this.queue.shift()!;
      const { url, depth } = item;

      // Normalize URL for visited check
      const normalized = normalizeUrl(url);

      // Skip already-visited URLs
      if (this.visited.has(normalized)) {
        continue;
      }

      // Skip if beyond max depth
      if (depth > this.config.maxDepth) {
        this.addSkipped(url, `Exceeds max depth (${this.config.maxDepth})`);
        continue;
      }

      // Mark as visited before fetching to avoid re-queueing
      this.visited.add(normalized);

      // Fetch, convert, write, and extract links
      try {
        const raw = await this.fetcher.fetch(url);
        const markdown = await this.converter.convert(raw.html, raw.url);

        const page: FetchedPage = {
          ...raw,
          markdown,
          depth,
        };

        // Write page to output immediately (streaming)
        await this.outputWriter.writePage(page);
        this.pages.push(page);

        // Fire onPageFetched callback
        this.config.onPageFetched?.(page);

        // Extract and enqueue links (only if we haven't hit the page limit)
        if (this.pages.length < this.config.maxPages) {
          const links = extractLinks(raw.html, raw.url, {
            sameDomainOnly: true,
            includePatterns: this.config.includePatterns,
            excludePatterns: this.config.excludePatterns,
          });

          for (const link of links) {
            const linkNormalized = normalizeUrl(link.url);
            if (!this.visited.has(linkNormalized)) {
              this.queue.push({ url: link.url, depth: depth + 1 });
            }
          }
        }
      } catch (error) {
        const err =
          error instanceof Error ? error : new Error(String(error));

        // Fire onError callback
        this.config.onError?.(url, err);

        // Record as skipped
        this.addSkipped(url, err.message);

        // Continue crawling - individual page errors don't abort
      }
    }

    // Any remaining items in the queue that weren't processed
    // (due to maxPages limit) are implicitly skipped

    return buildFetchResult(
      this.pages,
      this.skipped,
      this.config.outputDir,
      startTime,
    );
  }

  /**
   * Record a skipped page and fire the onPageSkipped callback.
   */
  private addSkipped(url: string, reason: string): void {
    this.skipped.push({ url, reason });
    this.config.onPageSkipped?.(url, reason);
  }
}

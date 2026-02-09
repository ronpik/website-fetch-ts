import { z } from 'zod';
import type {
  WebsiteFetchConfig,
  FetchedPage,
  SkippedPage,
  FetchResult,
} from '../types.js';
import type { Fetcher } from '../fetcher/index.js';
import type { Converter } from '../converter/index.js';
import type { OutputWriter } from '../output/index.js';
import type { LLMProvider } from '../llm/types.js';
import type { ExtractedLink } from '../fetcher/link-extractor.js';
import { extractLinks } from '../fetcher/link-extractor.js';
import { normalizeUrl, VisitedSet, buildFetchResult } from './base.js';

/** An item in the BFS queue. */
interface QueueItem {
  url: string;
  depth: number;
}

/** Zod schema for batch link classification response. */
const batchClassificationSchema = z.object({
  relevant: z.array(z.number()),
});

/** Zod schema for per-link classification response. */
const perLinkClassificationSchema = z.object({
  relevant: z.boolean(),
});

/** Maximum number of links per batch classification call. */
const BATCH_CHUNK_SIZE = 50;

/**
 * Build the prompt for batch link classification.
 *
 * Presents all links as a numbered list with their URL and surrounding
 * context, along with the crawl description.
 */
function buildBatchPrompt(links: ExtractedLink[], description: string): string {
  const linkList = links
    .map((link, index) => {
      const num = index + 1;
      const context = link.context ? ` -- "${link.context}"` : '';
      return `${num}. ${link.url}${context}`;
    })
    .join('\n');

  return (
    `Given the goal: "${description}"\n\n` +
    `Links found:\n${linkList}\n\n` +
    `Which links are relevant to the goal? Return their numbers.`
  );
}

/**
 * Build the prompt for per-link classification.
 *
 * Presents a single link with its URL, text, and context along with
 * the crawl description.
 */
function buildSinglePrompt(link: ExtractedLink, description: string): string {
  const context = link.context ? `\nContext: "${link.context}"` : '';
  const text = link.text ? `\nLink text: "${link.text}"` : '';

  return (
    `Given the goal: "${description}"\n\n` +
    `Is this link relevant?\n` +
    `URL: ${link.url}${text}${context}\n\n` +
    `Return whether this link is relevant to the goal.`
  );
}

/**
 * Classify links in batch mode.
 *
 * Presents all links (in chunks of up to BATCH_CHUNK_SIZE) in a numbered
 * list and asks the LLM which are relevant. Returns only the relevant links.
 *
 * On LLM error, falls back to including all links in the chunk.
 */
async function classifyLinksBatch(
  links: ExtractedLink[],
  description: string,
  llm: LLMProvider,
): Promise<ExtractedLink[]> {
  if (links.length === 0) {
    return [];
  }

  const relevant: ExtractedLink[] = [];

  // Process in chunks to avoid overly long prompts
  for (let offset = 0; offset < links.length; offset += BATCH_CHUNK_SIZE) {
    const chunk = links.slice(offset, offset + BATCH_CHUNK_SIZE);

    try {
      const prompt = buildBatchPrompt(chunk, description);
      const result = await llm.invokeStructured(
        prompt,
        batchClassificationSchema,
        { callSite: 'link-classifier' },
      );

      // Map 1-indexed numbers back to links, filtering invalid indices
      for (const num of result.relevant) {
        const index = num - 1; // Convert 1-indexed to 0-indexed
        if (index >= 0 && index < chunk.length) {
          relevant.push(chunk[index]);
        }
      }
    } catch {
      // Classification error: fall back to including all links in this chunk
      relevant.push(...chunk);
    }
  }

  return relevant;
}

/**
 * Classify a single link via LLM.
 *
 * Returns true if the LLM considers the link relevant to the crawl
 * description. On LLM error, falls back to true (include the link).
 */
async function classifyLinkSingle(
  link: ExtractedLink,
  description: string,
  llm: LLMProvider,
): Promise<boolean> {
  try {
    const prompt = buildSinglePrompt(link, description);
    const result = await llm.invokeStructured(
      prompt,
      perLinkClassificationSchema,
      { callSite: 'link-classifier-per-link' },
    );
    return result.relevant;
  } catch {
    // Classification error: fall back to including the link
    return true;
  }
}

/**
 * Classify links using per-link mode.
 *
 * Each link gets its own LLM call. Returns only the links classified
 * as relevant.
 */
async function classifyLinksPerLink(
  links: ExtractedLink[],
  description: string,
  llm: LLMProvider,
): Promise<ExtractedLink[]> {
  if (links.length === 0) {
    return [];
  }

  const results = await Promise.all(
    links.map(async (link) => {
      const isRelevant = await classifyLinkSingle(link, description, llm);
      return { link, isRelevant };
    }),
  );

  return results.filter((r) => r.isRelevant).map((r) => r.link);
}

/**
 * Smart BFS crawler that uses LLM link classification to determine
 * which discovered links are relevant to the crawl description.
 *
 * Follows the same BFS pattern as SimpleCrawler but adds an LLM
 * classification step after link extraction. Only links deemed relevant
 * by the LLM are enqueued for further crawling.
 *
 * Supports two classification modes:
 * - **batch** (default): All links from a page are classified in a single
 *   LLM call using a numbered list prompt.
 * - **per-link**: Each link gets its own individual LLM yes/no call.
 *
 * Smart mode uses `readability` conversion strategy with Layer 2
 * (strategy selection) enabled by default.
 *
 * Pages are written to output as they are fetched (streaming).
 */
export class SmartCrawler {
  private visited = new VisitedSet();
  private queue: QueueItem[] = [];
  private pages: FetchedPage[] = [];
  private skipped: SkippedPage[] = [];

  private readonly llm: LLMProvider;
  private readonly description: string;
  private readonly classificationMode: 'batch' | 'per-link';

  constructor(
    private config: WebsiteFetchConfig,
    private fetcher: Fetcher,
    private converter: Converter,
    private outputWriter: OutputWriter,
    llm: LLMProvider,
    description: string,
  ) {
    this.llm = llm;
    this.description = description;
    this.classificationMode = config.linkClassification ?? 'batch';
  }

  /**
   * Run the BFS crawl starting from the configured root URL.
   *
   * After each page is fetched, extracted links are classified by the LLM
   * before being added to the queue. Only relevant links are followed.
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

      // Fetch, convert, write, classify links, and enqueue
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

        // Extract, classify, and enqueue links (only if we haven't hit the page limit)
        if (this.pages.length < this.config.maxPages) {
          const links = extractLinks(raw.html, raw.url, {
            sameDomainOnly: true,
            includePatterns: this.config.includePatterns,
            excludePatterns: this.config.excludePatterns,
            pathPrefix: this.config.pathPrefix,
          });

          // Classify links via LLM before enqueueing
          const relevantLinks = await this.classifyLinks(links);

          for (const link of relevantLinks) {
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
   * Classify extracted links using the configured classification mode.
   *
   * @param links - The extracted links to classify
   * @returns Only the links deemed relevant by the LLM
   */
  private async classifyLinks(
    links: ExtractedLink[],
  ): Promise<ExtractedLink[]> {
    if (links.length === 0) {
      return [];
    }

    if (this.classificationMode === 'per-link') {
      return classifyLinksPerLink(links, this.description, this.llm);
    }

    return classifyLinksBatch(links, this.description, this.llm);
  }

  /**
   * Record a skipped page and fire the onPageSkipped callback.
   */
  private addSkipped(url: string, reason: string): void {
    this.skipped.push({ url, reason });
    this.config.onPageSkipped?.(url, reason);
  }
}

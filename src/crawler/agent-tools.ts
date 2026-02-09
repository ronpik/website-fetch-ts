import { tool } from 'ai';
import { z } from 'zod';

import type { WebsiteFetchConfig, FetchedPage, SkippedPage } from '../types.js';
import type { Fetcher } from '../fetcher/index.js';
import type { Converter } from '../converter/index.js';
import type { OutputWriter } from '../output/index.js';
import type { LLMProvider } from '../llm/types.js';
import type { ExtractedLink } from '../fetcher/link-extractor.js';
import { TempStorage } from './temp-storage.js';
import { normalizeUrl } from './base.js';

/**
 * Context object passed to tool builders, containing all dependencies
 * needed by the agent tools.
 */
export interface AgentToolContext {
  config: WebsiteFetchConfig;
  fetcher: Fetcher;
  converter: Converter;
  outputWriter: OutputWriter;
  llm: LLMProvider;
  tempStorage: TempStorage;
  description: string;

  /**
   * Mutable state shared across tools.
   * storedPages: pages that have been persisted via storePage.
   * skippedPages: pages that were marked irrelevant by the agent.
   * summaries: cached summaries keyed by URL.
   * storedCount: number of pages stored so far (for maxPages tracking).
   * done: set to true when the agent calls done().
   */
  storedPages: FetchedPage[];
  skippedPages: SkippedPage[];
  summaries: Map<string, string>;
  storedCount: number;
  done: boolean;
}

/**
 * Format extracted links as a readable string for the agent.
 */
function formatLinks(links: ExtractedLink[]): string {
  if (links.length === 0) {
    return 'No links found on this page.';
  }

  return links
    .map((link) => {
      const context = link.context ? ` -- "${link.context}"` : '';
      return `- ${link.url}${context}`;
    })
    .join('\n');
}

/**
 * Build the 5 agent tools used by the AgentCrawler.
 *
 * Each tool has access to the shared context object, which is mutated
 * during the crawl (e.g., storedPages, done flag).
 *
 * @param ctx - The shared agent tool context
 * @returns An object with all 5 tool definitions
 */
export function buildAgentTools(ctx: AgentToolContext) {
  const linkOptions = {
    sameDomainOnly: true,
    includePatterns: ctx.config.includePatterns,
    excludePatterns: ctx.config.excludePatterns,
    pathPrefix: ctx.config.pathPrefix,
  };

  return {
    /**
     * Fetch a page, convert to markdown, store in temp, summarize via LLM.
     * Returns the page summary (not the full content) to the agent.
     */
    fetchPage: tool({
      description:
        'Fetch a web page by URL. Returns a summary of the page content. ' +
        'Use this to explore pages and understand their content before deciding to store or skip them.',
      parameters: z.object({
        url: z.string().describe('The URL of the page to fetch'),
      }),
      execute: async ({ url }) => {
        const normalized = normalizeUrl(url);

        // If already fetched and in temp storage, return the cached summary
        if (ctx.tempStorage.has(normalized)) {
          const existingSummary = ctx.summaries.get(normalized);
          if (existingSummary) {
            return `Page already fetched. Summary:\n${existingSummary}`;
          }
        }

        try {
          // Fetch the raw HTML
          const raw = await ctx.fetcher.fetch(url);

          // Convert HTML to markdown
          const markdown = await ctx.converter.convert(raw.html, raw.url);

          // Store in temp storage (keyed by normalized URL)
          ctx.tempStorage.store(normalized, raw, markdown);

          // Generate a summary via LLM (page-summarizer call site)
          let summary: string;
          try {
            const summaryPrompt =
              `Summarize the following web page content in 200-500 words. ` +
              `Focus on the main topics, key information, and what the page is about.\n\n` +
              `URL: ${raw.url}\n\n` +
              `Content:\n${markdown.slice(0, 8000)}`; // Limit input to avoid token overflow

            summary = await ctx.llm.invoke(summaryPrompt, {
              callSite: 'page-summarizer',
            });
          } catch {
            // If summarization fails, create a basic summary from the markdown
            summary = markdown.slice(0, 500) + (markdown.length > 500 ? '...' : '');
          }

          // Cache the summary
          ctx.summaries.set(normalized, summary);

          return `Page fetched successfully: ${raw.url}\n\nSummary:\n${summary}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Failed to fetch page ${url}: ${message}`;
        }
      },
    }),

    /**
     * Move a page from temp storage to the final output.
     * Returns confirmation and extracted links with context.
     */
    storePage: tool({
      description:
        'Store a previously fetched page to the output. ' +
        'Use this when you determine a page is relevant to the crawl goal. ' +
        'Returns a list of links found on the page for further exploration.',
      parameters: z.object({
        url: z.string().describe('The URL of the page to store (must have been fetched first)'),
      }),
      execute: async ({ url }) => {
        const normalized = normalizeUrl(url);
        const entry = ctx.tempStorage.get(normalized);

        if (!entry) {
          return `Page not found in temporary storage: ${url}. You must fetch it first using fetchPage.`;
        }

        // Check if we've hit the maxPages limit
        if (ctx.storedCount >= ctx.config.maxPages) {
          return `Cannot store page: maximum page limit (${ctx.config.maxPages}) reached. Call done() to finish the crawl.`;
        }

        // Build the FetchedPage
        const page: FetchedPage = {
          ...entry.raw,
          markdown: entry.markdown,
          depth: 0, // Agent mode doesn't track depth
        };

        // Write to output
        try {
          await ctx.outputWriter.writePage(page);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Failed to write page to output: ${message}`;
        }

        // Track the stored page
        ctx.storedPages.push(page);
        ctx.storedCount++;

        // Fire callback
        ctx.config.onPageFetched?.(page);

        // Extract links before removing from temp
        const links = ctx.tempStorage.getLinks(normalized, linkOptions);

        // Remove from temp storage (it's now in the output)
        ctx.tempStorage.remove(normalized);

        const linksText = formatLinks(links);

        return (
          `Page stored successfully: ${url}\n` +
          `Total stored: ${ctx.storedCount}/${ctx.config.maxPages}\n\n` +
          `Links found on this page:\n${linksText}`
        );
      },
    }),

    /**
     * Mark a page as irrelevant, remove from temp storage.
     * Returns extracted links with context.
     */
    markIrrelevant: tool({
      description:
        'Mark a previously fetched page as irrelevant and discard it. ' +
        'Use this when a page is not relevant to the crawl goal. ' +
        'Returns a list of links found on the page for further exploration.',
      parameters: z.object({
        url: z.string().describe('The URL of the page to mark as irrelevant'),
      }),
      execute: async ({ url }) => {
        const normalized = normalizeUrl(url);
        const entry = ctx.tempStorage.get(normalized);

        if (!entry) {
          return `Page not found in temporary storage: ${url}. It may have already been stored or discarded.`;
        }

        // Extract links before removing
        const links = ctx.tempStorage.getLinks(normalized, linkOptions);

        // Remove from temp storage
        ctx.tempStorage.remove(normalized);

        // Track the skipped page
        ctx.skippedPages.push({ url: normalized, reason: 'Marked irrelevant by agent' });

        // Fire skipped callback
        ctx.config.onPageSkipped?.(url, 'Marked irrelevant by agent');

        const linksText = formatLinks(links);

        return (
          `Page marked as irrelevant and discarded: ${url}\n\n` +
          `Links found on this page:\n${linksText}`
        );
      },
    }),

    /**
     * Get links from a fetched page without storing or discarding it.
     */
    getLinks: tool({
      description:
        'Get the links found on a previously fetched page without storing or discarding it. ' +
        'Use this to see what links are available before deciding what to do with the page.',
      parameters: z.object({
        url: z.string().describe('The URL of the page to get links from'),
      }),
      execute: async ({ url }) => {
        const normalized = normalizeUrl(url);

        if (!ctx.tempStorage.has(normalized)) {
          return `Page not found in temporary storage: ${url}. You must fetch it first using fetchPage.`;
        }

        const links = ctx.tempStorage.getLinks(normalized, linkOptions);
        const linksText = formatLinks(links);

        return `Links found on ${url}:\n${linksText}`;
      },
    }),

    /**
     * Signal that the crawl is complete.
     */
    done: tool({
      description:
        'Signal that the crawl is complete. Call this when you have gathered enough relevant pages ' +
        'or there are no more relevant pages to explore.',
      parameters: z.object({}),
      execute: async () => {
        ctx.done = true;
        return `Crawl complete. Total pages stored: ${ctx.storedCount}.`;
      },
    }),
  };
}

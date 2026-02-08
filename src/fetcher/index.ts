import type { FetchedPageRaw, WebsiteFetchConfig } from '../types.js';
import {
  type RobotsCache,
  DEFAULT_USER_AGENT,
  getOrigin,
  isUrlAllowed,
  getCrawlDelay,
} from './robots.js';
import { loadCookieFile, matchCookies, type Cookie } from './cookies.js';
import { FetchQueue } from './queue.js';

/**
 * The core fetcher interface used by all crawling modes.
 */
export interface Fetcher {
  /** Fetch a URL and return raw page data. */
  fetch(url: string): Promise<FetchedPageRaw>;
  /** Check if a URL is allowed by robots.txt. */
  isAllowed(url: string): Promise<boolean>;
  /** Get the crawl delay for a URL's domain (from robots.txt). */
  getCrawlDelay(url: string): number | undefined;
  /** Clean up resources. */
  close(): void;
}

/** Maximum number of redirects to follow. */
const MAX_REDIRECTS = 5;

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Content types considered as HTML. */
const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Error thrown when a fetch operation fails in an expected way.
 */
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Default max retries for 5xx errors. */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Convert a Response's headers to a plain object.
 */
function responseHeadersToRecord(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/**
 * Create a Fetcher instance configured with the given options.
 *
 * All HTTP fetch requests are routed through a rate-limited queue that
 * enforces concurrency limits and adaptively adjusts request delay
 * based on server responses (429, 5xx, sustained success).
 *
 * @param config - The website-fetch configuration
 * @returns A Fetcher instance
 */
export function createFetcher(config: WebsiteFetchConfig): Fetcher {
  const robotsCache: RobotsCache = new Map();
  const userAgent =
    config.headers?.['User-Agent'] ??
    config.headers?.['user-agent'] ??
    DEFAULT_USER_AGENT;

  // Load cookies from cookie file if specified
  let cookies: Cookie[] = [];
  if (config.cookieFile) {
    cookies = loadCookieFile(config.cookieFile);
  }

  // Create the rate-limited fetch queue
  const fetchQueue = new FetchQueue({
    delay: config.delay,
    concurrency: config.concurrency,
    maxRetries: DEFAULT_MAX_RETRIES,
    adaptiveRateLimit: config.adaptiveRateLimit,
  });

  // Track which origins have had their crawl-delay applied
  const crawlDelayApplied = new Set<string>();

  /**
   * Apply the crawl-delay from robots.txt as a floor for the rate limiter,
   * if it hasn't been applied yet for this origin.
   */
  function applyCrawlDelayFloor(url: string): void {
    const origin = getOrigin(url);
    if (crawlDelayApplied.has(origin)) {
      return;
    }
    crawlDelayApplied.add(origin);

    const crawlDelaySec = getCrawlDelay(origin, robotsCache);
    if (crawlDelaySec !== undefined && crawlDelaySec > 0) {
      fetchQueue.rateLimiter.setCrawlDelayFloor(crawlDelaySec * 1000);
    }
  }

  /**
   * Perform the raw HTTP fetch for a URL, handling redirects.
   * This is the function that gets rate-limited by the queue.
   */
  async function rawFetch(url: string, requestHeaders: Record<string, string>): Promise<FetchedPageRaw> {
    let currentUrl = url;
    let response: Response | undefined;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        DEFAULT_TIMEOUT_MS,
      );

      try {
        response = await fetch(currentUrl, {
          headers: requestHeaders,
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new FetchError(
            `Request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${currentUrl}`,
            url,
          );
        }
        throw new FetchError(
          `Network error fetching ${currentUrl}: ${error instanceof Error ? error.message : String(error)}`,
          url,
        );
      } finally {
        clearTimeout(timeout);
      }

      // Handle redirects
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new FetchError(
            `Redirect response missing Location header: ${currentUrl}`,
            url,
            status,
          );
        }
        // Resolve relative redirect URLs
        currentUrl = new URL(location, currentUrl).href;

        if (redirectCount === MAX_REDIRECTS) {
          throw new FetchError(
            `Too many redirects (max ${MAX_REDIRECTS}): ${url}`,
            url,
            status,
          );
        }
        continue;
      }

      break;
    }

    if (!response) {
      throw new FetchError(`No response received for: ${url}`, url);
    }

    // Check status code - include headers in error for rate limiter to use
    if (!response.ok) {
      const errorHeaders = responseHeadersToRecord(response);
      throw new FetchError(
        `HTTP ${response.status} for ${currentUrl}`,
        url,
        response.status,
        errorHeaders,
      );
    }

    // Check content type - skip non-HTML responses
    const contentType = response.headers.get('content-type') ?? '';
    const isHtml = HTML_CONTENT_TYPES.some((type) =>
      contentType.toLowerCase().includes(type),
    );

    if (!isHtml) {
      throw new FetchError(
        `Non-HTML content type (${contentType}): ${currentUrl}`,
        url,
        response.status,
      );
    }

    // Read the response body
    const html = await response.text();

    // Convert response headers to plain object
    const responseHeaders = responseHeadersToRecord(response);

    return {
      url: currentUrl, // Final URL after redirects
      html,
      statusCode: response.status,
      headers: responseHeaders,
      fetchedAt: new Date(),
    };
  }

  return {
    async fetch(url: string): Promise<FetchedPageRaw> {
      // Check robots.txt unless disabled (before queueing)
      if (config.respectRobots) {
        const allowed = await isUrlAllowed(url, robotsCache, userAgent);
        if (!allowed) {
          throw new FetchError(
            `URL disallowed by robots.txt: ${url}`,
            url,
          );
        }
        // Apply crawl-delay floor after robots.txt has been fetched
        applyCrawlDelayFloor(url);
      }

      // Build request headers
      const requestHeaders: Record<string, string> = {
        'User-Agent': userAgent,
        ...config.headers,
      };

      // Add matching cookies
      const cookieHeader = matchCookies(cookies, url);
      if (cookieHeader) {
        requestHeaders['Cookie'] = cookieHeader;
      }

      // Execute the fetch through the rate-limited queue
      return fetchQueue.add(() => rawFetch(url, requestHeaders));
    },

    async isAllowed(url: string): Promise<boolean> {
      if (!config.respectRobots) {
        return true;
      }
      return isUrlAllowed(url, robotsCache, userAgent);
    },

    getCrawlDelay(url: string): number | undefined {
      const origin = getOrigin(url);
      return getCrawlDelay(origin, robotsCache);
    },

    close(): void {
      robotsCache.clear();
      fetchQueue.clear();
      crawlDelayApplied.clear();
    },
  };
}

// Re-export types and utilities for external use
export { DEFAULT_USER_AGENT } from './robots.js';
export type { RobotsCache, RobotsCacheEntry } from './robots.js';
export type { Cookie } from './cookies.js';
export { AdaptiveRateLimiter, parseRetryAfter } from './rate-limiter.js';
export type { RateLimiterConfig } from './rate-limiter.js';
export { FetchQueue } from './queue.js';
export type { FetchQueueConfig } from './queue.js';
export { extractLinks } from './link-extractor.js';
export type { ExtractedLink, ExtractLinksOptions } from './link-extractor.js';

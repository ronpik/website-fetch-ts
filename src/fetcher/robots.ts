import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const robotsParser = require('robots-parser') as (
  url: string,
  robotstxt: string,
) => Robot;

/**
 * Parsed robots.txt instance from robots-parser library.
 */
export interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
}

/**
 * Cached robots.txt data for a domain.
 */
export interface RobotsCacheEntry {
  /** The parsed robots.txt instance */
  robot: Robot;
  /** Crawl-delay in seconds, if specified */
  crawlDelay: number | undefined;
}

/**
 * Cache of robots.txt data, keyed by domain origin (e.g., "https://example.com").
 */
export type RobotsCache = Map<string, RobotsCacheEntry>;

/**
 * Default user agent string for robots.txt compliance.
 */
export const DEFAULT_USER_AGENT = 'website-fetch/1.0';

/**
 * Extract the origin from a URL string (protocol + hostname + port).
 *
 * @param url - Full URL string
 * @returns Origin string (e.g., "https://example.com")
 */
export function getOrigin(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

/**
 * Fetch and parse robots.txt for a given domain origin.
 * If the fetch fails (404, timeout, network error), returns an "allow all" entry.
 *
 * @param origin - The domain origin (e.g., "https://example.com")
 * @param userAgent - User agent string for the fetch request
 * @param timeoutMs - Timeout for the robots.txt fetch in milliseconds
 * @returns Parsed robots cache entry
 */
export async function fetchRobotsTxt(
  origin: string,
  userAgent: string,
  timeoutMs: number = 10000,
): Promise<RobotsCacheEntry> {
  const robotsUrl = `${origin}/robots.txt`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // Non-200 response (including 404) => allow all
      return createAllowAllEntry(robotsUrl);
    }

    const text = await response.text();
    const robot = robotsParser(robotsUrl, text);
    const crawlDelay = robot.getCrawlDelay(userAgent);

    return { robot, crawlDelay };
  } catch {
    // Network error, timeout, abort => allow all
    return createAllowAllEntry(robotsUrl);
  }
}

/**
 * Create an "allow all" robots cache entry (empty robots.txt).
 */
function createAllowAllEntry(robotsUrl: string): RobotsCacheEntry {
  const robot = robotsParser(robotsUrl, '');
  return { robot, crawlDelay: undefined };
}

/**
 * Check if a URL is allowed by robots.txt, using a cache to avoid
 * re-fetching robots.txt for the same domain.
 *
 * @param url - The URL to check
 * @param cache - Robots cache (populated on first access per domain)
 * @param userAgent - User agent string for robots.txt matching
 * @param timeoutMs - Timeout for robots.txt fetch
 * @returns true if the URL is allowed, false if disallowed
 */
export async function isUrlAllowed(
  url: string,
  cache: RobotsCache,
  userAgent: string,
  timeoutMs?: number,
): Promise<boolean> {
  const origin = getOrigin(url);

  let entry = cache.get(origin);
  if (!entry) {
    entry = await fetchRobotsTxt(origin, userAgent, timeoutMs);
    cache.set(origin, entry);
  }

  const result = entry.robot.isAllowed(url, userAgent);
  // robots-parser returns undefined for URLs not matching any rule => treat as allowed
  return result !== false;
}

/**
 * Get the crawl delay for a domain from the robots.txt cache.
 * Returns undefined if not cached or no crawl-delay directive.
 *
 * @param origin - The domain origin
 * @param cache - Robots cache
 * @returns Crawl delay in seconds, or undefined
 */
export function getCrawlDelay(
  origin: string,
  cache: RobotsCache,
): number | undefined {
  const entry = cache.get(origin);
  return entry?.crawlDelay;
}

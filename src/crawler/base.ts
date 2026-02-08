import type { FetchedPage, SkippedPage, FetchResult } from '../types.js';

/**
 * Normalize a URL for deduplication purposes.
 *
 * - Strips trailing slashes from the pathname (unless the path is just "/")
 * - Strips fragments
 * - Strips query parameters
 * - Lowercases the hostname
 *
 * This ensures that `https://example.com/docs` and `https://example.com/docs/`
 * are treated as the same URL.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // If the URL can't be parsed, return as-is
    return url;
  }

  // Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip fragment and query
  parsed.hash = '';
  parsed.search = '';

  // Strip trailing slash from pathname (unless it's just "/")
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.href;
}

/**
 * A set that tracks visited URLs using normalized forms.
 *
 * URLs are normalized before checking/adding so that
 * `https://example.com/docs` and `https://example.com/docs/` are
 * considered the same URL.
 */
export class VisitedSet {
  private set = new Set<string>();

  /**
   * Check whether a URL (after normalization) has been visited.
   */
  has(url: string): boolean {
    return this.set.has(normalizeUrl(url));
  }

  /**
   * Mark a URL (after normalization) as visited.
   */
  add(url: string): void {
    this.set.add(normalizeUrl(url));
  }

  /**
   * Return the number of visited URLs.
   */
  get size(): number {
    return this.set.size;
  }
}

/**
 * Build a FetchResult from collected pages, skipped pages, and timing info.
 */
export function buildFetchResult(
  pages: FetchedPage[],
  skipped: SkippedPage[],
  outputPath: string,
  startTime: number,
): FetchResult {
  return {
    pages,
    skipped,
    outputPath,
    stats: {
      totalPages: pages.length,
      totalSkipped: skipped.length,
      duration: Date.now() - startTime,
    },
  };
}

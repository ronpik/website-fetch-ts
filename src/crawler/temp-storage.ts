import type { FetchedPageRaw } from '../types.js';
import { extractLinks } from '../fetcher/link-extractor.js';
import type { ExtractedLink, ExtractLinksOptions } from '../fetcher/link-extractor.js';

/**
 * Entry stored in temporary page storage.
 */
export interface TempStorageEntry {
  raw: FetchedPageRaw;
  markdown: string;
}

/**
 * In-memory temporary storage for pages during agent crawling.
 *
 * Pages are stored here after fetching and conversion, before the agent
 * decides whether to persist them (storePage) or discard them (markIrrelevant).
 * Keyed by URL.
 */
export class TempStorage {
  private map = new Map<string, TempStorageEntry>();

  /**
   * Store a fetched page with its converted markdown.
   *
   * @param url - The page URL (used as the key)
   * @param raw - The raw fetched page data
   * @param markdown - The converted markdown content
   */
  store(url: string, raw: FetchedPageRaw, markdown: string): void {
    this.map.set(url, { raw, markdown });
  }

  /**
   * Retrieve a stored page entry by URL.
   *
   * @param url - The page URL
   * @returns The stored entry, or undefined if not found
   */
  get(url: string): TempStorageEntry | undefined {
    return this.map.get(url);
  }

  /**
   * Remove a page from temporary storage.
   *
   * @param url - The page URL to remove
   * @returns true if the entry existed and was removed, false otherwise
   */
  remove(url: string): boolean {
    return this.map.delete(url);
  }

  /**
   * Check whether a URL exists in temporary storage.
   *
   * @param url - The page URL to check
   * @returns true if the URL is stored
   */
  has(url: string): boolean {
    return this.map.has(url);
  }

  /**
   * Extract links from a page stored in temporary storage.
   *
   * @param url - The page URL to extract links from
   * @param options - Optional link extraction/filtering options
   * @returns Array of extracted links, or empty array if the URL is not stored
   */
  getLinks(url: string, options?: ExtractLinksOptions): ExtractedLink[] {
    const entry = this.map.get(url);
    if (!entry) {
      return [];
    }
    return extractLinks(entry.raw.html, entry.raw.url, options);
  }

  /**
   * Return all URLs currently in temporary storage.
   */
  urls(): string[] {
    return Array.from(this.map.keys());
  }

  /**
   * Return the number of pages in temporary storage.
   */
  get size(): number {
    return this.map.size;
  }
}

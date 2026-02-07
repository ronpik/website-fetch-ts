import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FetchedPage } from '../types.js';

/**
 * Single-file output writer.
 *
 * Concatenates all fetched pages into a single markdown file (`aggregated.md`)
 * with horizontal rule separators and source URL headings. Pages are ordered
 * by depth-first traversal (parents before children, sorted by URL path segments).
 */
export class SingleFileWriter {
  /**
   * Write all pages to a single aggregated markdown file.
   *
   * @param pages - All fetched pages to include
   * @param outputDir - Directory to write the aggregated file into
   * @param rootUrl - The root URL used to generate the header
   * @returns The file path of the written aggregated file
   */
  async write(
    pages: FetchedPage[],
    outputDir: string,
    rootUrl: string,
  ): Promise<string> {
    const sorted = this.sortByDepthFirst(pages);

    const header = `# Aggregated Content: ${this.buildHeaderLabel(rootUrl)}`;

    const sections = sorted.map(
      (page) => `---\n## Source: ${page.url}\n\n${page.markdown}`,
    );

    const content = `${header}\n\n${sections.join('\n\n')}\n`;

    await mkdir(outputDir, { recursive: true });

    const filePath = join(outputDir, 'aggregated.md');
    await writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Build the header label from the root URL.
   *
   * Includes hostname and pathname (without trailing slash for non-root paths).
   * Examples:
   * - `https://example.com/` -> `example.com`
   * - `https://example.com/docs` -> `example.com/docs`
   * - `https://example.com/docs/` -> `example.com/docs`
   */
  private buildHeaderLabel(rootUrl: string): string {
    const parsed = new URL(rootUrl);
    let label = parsed.hostname;

    // Include pathname if it's not just the root
    let pathname = parsed.pathname;
    if (pathname !== '/') {
      // Remove trailing slash
      if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      label += pathname;
    }

    return label;
  }

  /**
   * Sort pages by depth-first traversal order.
   *
   * Pages are ordered by their URL path segments so that parent pages
   * appear before their children, and siblings are sorted alphabetically.
   */
  private sortByDepthFirst(pages: FetchedPage[]): FetchedPage[] {
    return [...pages].sort((a, b) => {
      const segmentsA = this.getPathSegments(a.url);
      const segmentsB = this.getPathSegments(b.url);

      // Compare segment by segment
      const minLen = Math.min(segmentsA.length, segmentsB.length);
      for (let i = 0; i < minLen; i++) {
        const cmp = segmentsA[i].localeCompare(segmentsB[i]);
        if (cmp !== 0) return cmp;
      }

      // Shorter paths (parents) come before longer paths (children)
      return segmentsA.length - segmentsB.length;
    });
  }

  /**
   * Extract path segments from a URL for sorting purposes.
   */
  private getPathSegments(url: string): string[] {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    // Split and filter out empty segments (from leading/trailing slashes)
    return pathname.split('/').filter((seg) => seg.length > 0);
  }
}

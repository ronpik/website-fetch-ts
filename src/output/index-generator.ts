import { writeFile, mkdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';

import type { FetchedPage } from '../types.js';
import { urlToPath, pathToMirrorFile, pathToFlatFile } from './utils.js';

/**
 * Represents a single entry in the generated index file.
 */
export interface IndexEntry {
  title: string;
  relativePath: string;
  description?: string; // Filled by LLM in Phase 4
  depth: number;
}

/**
 * Extract the title from markdown content.
 *
 * Looks for the first `# ` heading in the markdown. If none is found,
 * derives a human-readable name from the URL path.
 *
 * @param markdown - The markdown content to search
 * @param url - The page URL used as fallback for title derivation
 * @returns The extracted or derived title
 */
export function extractTitle(markdown: string, url: string): string {
  // Look for the first H1 heading (# Title)
  const match = markdown.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }

  // Fallback: derive a title from the URL path
  return titleFromUrl(url);
}

/**
 * Derive a human-readable title from a URL.
 *
 * Takes the last meaningful path segment, replaces hyphens/underscores
 * with spaces, and title-cases the result.
 */
function titleFromUrl(url: string): string {
  const urlPath = urlToPath(url);
  // Strip leading/trailing slashes
  const trimmed = urlPath.replace(/^\/+|\/+$/g, '');

  if (trimmed === '') {
    // Root page
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return 'Home';
    }
  }

  // Take the last path segment
  const segments = trimmed.split('/');
  const last = segments[segments.length - 1];

  // Replace hyphens and underscores with spaces, then title-case
  return last
    .replace(/[-_]/g, ' ')
    .replace(/\.\w+$/, '') // strip file extension if present
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract the domain (hostname + pathname prefix) for the index header.
 */
function extractDomain(pages: FetchedPage[]): string {
  if (pages.length === 0) {
    return 'unknown';
  }

  try {
    const parsed = new URL(pages[0].url);
    // Find the common path prefix among all pages
    const paths = pages.map((p) => {
      try {
        return new URL(p.url).pathname;
      } catch {
        return '/';
      }
    });

    // Use the shortest common prefix
    let commonPrefix = paths[0];
    for (const path of paths) {
      while (!path.startsWith(commonPrefix)) {
        commonPrefix = commonPrefix.substring(
          0,
          commonPrefix.lastIndexOf('/'),
        );
      }
    }

    // Clean up the prefix for display
    const prefix = commonPrefix === '/' ? '' : commonPrefix;
    return parsed.hostname + prefix;
  } catch {
    return 'unknown';
  }
}

/**
 * Index file generator that creates a table of contents for all fetched pages.
 *
 * Supports two modes:
 * - **mirror**: Hierarchical index with indentation reflecting folder structure
 * - **flat**: Simple flat list sorted by path
 *
 * An optional `descriptionProvider` callback can supply descriptions for each page,
 * enabling future LLM integration (Phase 4) without coupling to the LLM layer.
 */
export class IndexGenerator {
  /**
   * Generate an index file for the given pages.
   *
   * @param pages - All fetched pages to include in the index
   * @param outputDir - The output directory where the index file will be written
   * @param structure - Output structure mode ('mirror' or 'flat')
   * @param descriptionProvider - Optional callback to generate descriptions for pages
   * @returns The file path of the generated index file
   */
  async generate(
    pages: FetchedPage[],
    outputDir: string,
    structure: 'mirror' | 'flat',
    descriptionProvider?: (page: FetchedPage) => Promise<string>,
  ): Promise<string> {
    const indexPath = join(outputDir, 'INDEX.md');

    // Build index entries
    const entries = await this.buildEntries(
      pages,
      outputDir,
      structure,
      descriptionProvider,
    );

    // Generate markdown content
    const domain = extractDomain(pages);
    const content = this.renderIndex(entries, domain, pages.length, structure);

    // Write the index file
    await mkdir(outputDir, { recursive: true });
    await writeFile(indexPath, content, 'utf-8');

    return indexPath;
  }

  /**
   * Build index entries from pages, sorted by depth then path.
   */
  private async buildEntries(
    pages: FetchedPage[],
    outputDir: string,
    structure: 'mirror' | 'flat',
    descriptionProvider?: (page: FetchedPage) => Promise<string>,
  ): Promise<IndexEntry[]> {
    const indexFilePath = join(outputDir, 'INDEX.md');
    const indexDir = dirname(indexFilePath);

    // Sort pages by depth first, then by URL path for consistent ordering
    const sorted = [...pages].sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      const pathA = urlToPath(a.url);
      const pathB = urlToPath(b.url);
      return pathA.localeCompare(pathB);
    });

    const entries: IndexEntry[] = [];

    for (const page of sorted) {
      const title = page.title ?? extractTitle(page.markdown, page.url);

      // Calculate the file path for this page
      const urlPath = urlToPath(page.url);
      const filePath =
        structure === 'mirror'
          ? pathToMirrorFile(urlPath, outputDir)
          : pathToFlatFile(urlPath, outputDir);

      // Calculate relative path from index file location
      const relativePath = relative(indexDir, filePath);

      // Get description if provider is available
      let description: string | undefined;
      if (descriptionProvider) {
        try {
          description = await descriptionProvider(page);
        } catch {
          // Silently skip failed descriptions
        }
      }

      entries.push({
        title,
        relativePath,
        description,
        depth: page.depth,
      });
    }

    return entries;
  }

  /**
   * Render the index markdown content.
   */
  private renderIndex(
    entries: IndexEntry[],
    domain: string,
    totalPages: number,
    structure: 'mirror' | 'flat',
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(`# Site Index: ${domain}`);
    lines.push('');

    if (entries.length > 0) {
      if (structure === 'mirror') {
        this.renderMirrorEntries(entries, lines);
      } else {
        this.renderFlatEntries(entries, lines);
      }
      lines.push('');
    }

    // Footer
    lines.push(`Total: ${totalPages} pages fetched`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Render entries in mirror (hierarchical) mode with indentation.
   * Uses 2 spaces per depth level for indentation.
   */
  private renderMirrorEntries(
    entries: IndexEntry[],
    lines: string[],
  ): void {
    for (const entry of entries) {
      const indent = '  '.repeat(entry.depth);
      const link = `[${entry.title}](${entry.relativePath})`;
      const desc = entry.description ? ` \u2014 ${entry.description}` : '';
      lines.push(`${indent}- ${link}${desc}`);
    }
  }

  /**
   * Render entries in flat mode as a simple list sorted by path.
   */
  private renderFlatEntries(
    entries: IndexEntry[],
    lines: string[],
  ): void {
    // Flat mode: sort by relativePath for consistent ordering
    const sorted = [...entries].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );

    for (const entry of sorted) {
      const link = `[${entry.title}](${entry.relativePath})`;
      const desc = entry.description ? ` \u2014 ${entry.description}` : '';
      lines.push(`- ${link}${desc}`);
    }
  }
}

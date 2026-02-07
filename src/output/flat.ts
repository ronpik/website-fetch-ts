import { mkdir, writeFile } from 'node:fs/promises';

import type { FetchedPage } from '../types.js';
import { urlToPath, pathToFlatFile, addFrontMatter } from './utils.js';

/**
 * Flat output writer.
 *
 * Places all files in a single directory with URL paths encoded in filenames.
 * Example: `https://example.com/docs/api/auth` -> `output/docs_api_auth.md`
 */
export class FlatWriter {
  constructor(private outputDir: string) {}

  /**
   * Write a fetched page to the flat output directory.
   *
   * @param page - The fetched page with markdown content
   * @returns The absolute file path that was written
   */
  async writePage(page: FetchedPage): Promise<string> {
    const filePath = this.urlToFilePath(page.url);

    const content = addFrontMatter(page.markdown, {
      source: page.url,
      fetchedAt: page.fetchedAt.toISOString(),
    });

    await mkdir(this.outputDir, { recursive: true });
    await writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Convert a full URL to the corresponding flat file path.
   */
  urlToFilePath(url: string): string {
    const urlPath = urlToPath(url);
    return pathToFlatFile(urlPath, this.outputDir);
  }
}

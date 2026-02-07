import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FetchedPage } from '../types.js';
import { urlToPath, pathToMirrorFile, addFrontMatter } from './utils.js';

/**
 * Mirror output writer.
 *
 * Maps URL paths to file paths preserving directory hierarchy.
 * Example: `https://example.com/docs/api/auth` -> `output/docs/api/auth.md`
 */
export class MirrorWriter {
  constructor(private outputDir: string) {}

  /**
   * Write a fetched page to the mirror directory structure.
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

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Convert a full URL to the corresponding mirror file path.
   */
  urlToFilePath(url: string): string {
    const urlPath = urlToPath(url);
    return pathToMirrorFile(urlPath, this.outputDir);
  }
}

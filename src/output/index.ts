export { MirrorWriter } from './mirror.js';
export { FlatWriter } from './flat.js';
export { SingleFileWriter } from './single-file.js';
export { IndexGenerator, extractTitle, createLLMDescriptionProvider } from './index-generator.js';
export type { IndexEntry } from './index-generator.js';
export {
  urlToPath,
  sanitizeFilename,
  addFrontMatter,
  pathToMirrorFile,
  pathToFlatFile,
} from './utils.js';

import type { WebsiteFetchConfig } from '../types.js';
import { MirrorWriter } from './mirror.js';
import { FlatWriter } from './flat.js';

/**
 * Common interface for output writers.
 */
export interface OutputWriter {
  writePage(
    page: import('../types.js').FetchedPage,
  ): Promise<string>;
  urlToFilePath(url: string): string;
}

/**
 * Factory function that returns the appropriate output writer
 * based on the configuration's `outputStructure` setting.
 */
export function createOutputWriter(config: WebsiteFetchConfig): OutputWriter {
  switch (config.outputStructure) {
    case 'mirror':
      return new MirrorWriter(config.outputDir);
    case 'flat':
      return new FlatWriter(config.outputDir);
    default: {
      const _exhaustive: never = config.outputStructure;
      throw new Error(`Unknown output structure: ${_exhaustive}`);
    }
  }
}

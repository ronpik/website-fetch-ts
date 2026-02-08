import type { WebsiteFetchConfig } from '../types.js';
import { getStrategy } from './strategies/index.js';

export type { ConversionStrategy } from './strategies/index.js';
export {
  DefaultStrategy,
  ReadabilityStrategy,
  CustomStrategy,
  createTurndownService,
  getStrategy,
} from './strategies/index.js';

/**
 * Converter object returned by `createConverter`.
 *
 * Provides a single `convert` method that transforms HTML into markdown
 * using the configured conversion strategy.
 */
export interface Converter {
  convert(html: string, url: string): Promise<string>;
}

/**
 * Create a converter with the specified conversion strategy.
 *
 * The converter is the Layer 1 entry point for the conversion pipeline.
 * It selects the appropriate strategy based on `config.conversionStrategy`
 * and delegates HTML-to-markdown conversion to it.
 *
 * @param config - The website-fetch configuration (uses conversionStrategy and customConverter fields)
 * @returns A Converter object with a `convert(html, url)` method
 */
export function createConverter(config: WebsiteFetchConfig): Converter {
  const strategy = getStrategy(config.conversionStrategy, config.customConverter);

  return {
    async convert(html: string, url: string): Promise<string> {
      return strategy.convert(html, url);
    },
  };
}

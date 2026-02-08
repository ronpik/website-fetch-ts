import type { ConversionStrategy } from './index.js';

/**
 * Custom conversion strategy.
 *
 * Wraps a user-provided converter function that takes raw HTML and a URL,
 * and returns a Promise resolving to a markdown string.
 */
export class CustomStrategy implements ConversionStrategy {
  constructor(
    private readonly converter: (html: string, url: string) => Promise<string>,
  ) {}

  async convert(html: string, url: string): Promise<string> {
    return this.converter(html, url);
  }
}

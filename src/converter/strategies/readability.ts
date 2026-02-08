import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

import type { ConversionStrategy } from './index.js';
import { DefaultStrategy } from './default.js';

/**
 * Readability conversion strategy.
 *
 * Uses Mozilla Readability to extract the main article content from HTML,
 * stripping navigation, sidebars, footers, and other non-content elements.
 * The extracted article HTML is then passed to Turndown for markdown conversion.
 *
 * If Readability cannot extract content (returns null), falls back to the
 * default strategy which converts the full HTML.
 */
export class ReadabilityStrategy implements ConversionStrategy {
  private readonly fallback: DefaultStrategy;

  constructor() {
    this.fallback = new DefaultStrategy();
  }

  async convert(html: string, url: string): Promise<string> {
    if (!html || html.trim().length === 0) {
      return '';
    }

    // Create a JSDOM document with the page URL as base for relative link resolution
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Run Readability to extract main content
    const reader = new Readability(document);
    const article = reader.parse();

    // If Readability cannot extract content, fall back to default strategy
    if (!article || !article.content) {
      return this.fallback.convert(html, url);
    }

    // Convert the extracted article HTML to markdown using the default strategy
    return this.fallback.convert(article.content, url);
  }
}

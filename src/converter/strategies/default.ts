import TurndownService from 'turndown';

import type { ConversionStrategy } from './index.js';

/**
 * Create a pre-configured TurndownService instance with sensible defaults.
 *
 * Configuration:
 * - ATX-style headings (`#`, `##`, etc.)
 * - `-` bullet list markers
 * - Fenced code blocks (triple backticks)
 * - GFM table support via custom rules
 */
export function createTurndownService(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    strongDelimiter: '**',
    emDelimiter: '_',
  });

  // Remove script and style elements from output
  turndown.remove(['script', 'style']);

  // GFM table support (manual rules since turndown-plugin-gfm is not installed)
  turndown.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement(content, node) {
      const trimmed = content.trim().replace(/\n/g, ' ');
      const el = node as HTMLElement;
      const isLastChild = !el.nextElementSibling;
      return isLastChild ? ` ${trimmed} |` : ` ${trimmed} |`;
    },
  });

  turndown.addRule('tableRow', {
    filter: 'tr',
    replacement(content, node) {
      const el = node as HTMLElement;
      let output = `|${content}\n`;

      // If this is the first row inside a thead, or the first row of the table
      // that contains th elements, add a separator row after it
      const parent = el.parentElement;
      const isHeaderRow =
        (parent?.nodeName === 'THEAD' && el === parent.firstElementChild) ||
        (parent?.nodeName === 'TBODY' &&
          !el.previousElementSibling &&
          !parent.parentElement?.querySelector('thead') &&
          el.querySelector('th'));

      if (isHeaderRow) {
        const cells = el.querySelectorAll('th, td');
        const separator = Array.from(cells)
          .map(() => ' --- ')
          .join('|');
        output += `|${separator}|\n`;
      }

      return output;
    },
  });

  turndown.addRule('table', {
    filter: 'table',
    replacement(content) {
      // If the table content does not contain a separator row (---),
      // we need to add one after the first row for valid GFM
      const lines = content.trim().split('\n');
      if (lines.length > 0 && !lines.some((line) => /^\|[\s-|]+\|$/.test(line))) {
        // Count cells in the first row
        const firstRow = lines[0];
        const cellCount = (firstRow.match(/\|/g) || []).length - 1;
        if (cellCount > 0) {
          const separator = `|${Array(cellCount).fill(' --- ').join('|')}|`;
          lines.splice(1, 0, separator);
        }
      }
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });

  turndown.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement(content) {
      return content;
    },
  });

  return turndown;
}

/**
 * Default conversion strategy using Turndown only.
 *
 * Converts raw HTML to markdown using a pre-configured TurndownService
 * with ATX headings, fenced code blocks, and GFM table support.
 */
export class DefaultStrategy implements ConversionStrategy {
  private readonly turndown: TurndownService;

  constructor() {
    this.turndown = createTurndownService();
  }

  async convert(html: string, _url: string): Promise<string> {
    if (!html || html.trim().length === 0) {
      return '';
    }
    return this.turndown.turndown(html);
  }
}

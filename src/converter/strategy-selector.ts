import { z } from 'zod';
import type { LLMProvider } from '../llm/types.js';

/**
 * Schema for the LLM strategy selection response.
 */
const strategySchema = z.object({
  strategy: z.enum(['default', 'readability']),
});

/**
 * Layer 2: LLM-based strategy selection.
 *
 * Sends the first ~2KB of HTML to the LLM for analysis and selects
 * the most appropriate conversion strategy ('default' or 'readability').
 *
 * Used in smart and agent modes. Falls back to the provided default
 * strategy on any LLM error.
 *
 * @param html - The full HTML content of the page
 * @param url - The page URL for context
 * @param llm - The LLM provider to use for analysis
 * @param fallbackStrategy - Strategy to use if LLM call fails
 * @returns The selected strategy name
 */
export async function selectStrategy(
  html: string,
  url: string,
  llm: LLMProvider,
  fallbackStrategy: 'default' | 'readability' = 'readability',
): Promise<'default' | 'readability'> {
  const snippet = html.substring(0, 2000); // First ~2KB for analysis

  const prompt = `Analyze this HTML snippet from ${url} and determine the best conversion strategy for converting it to markdown.

Choose one of:
- "default": Best for simple, well-structured HTML pages (documentation, blog posts, articles with clean markup)
- "readability": Best for complex pages with significant navigation, ads, sidebars, or cluttered layouts that need content extraction

HTML snippet:
\`\`\`html
${snippet}
\`\`\`

Select the strategy that will produce the cleanest markdown output.`;

  try {
    const result = await llm.invokeStructured(prompt, strategySchema, {
      callSite: 'conversion-strategy-selector',
    });
    return result.strategy;
  } catch {
    // Fall back to mode default on any LLM error
    return fallbackStrategy;
  }
}

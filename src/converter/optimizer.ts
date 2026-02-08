import { z } from 'zod';
import type { LLMProvider } from '../llm/types.js';

/**
 * Schema for the LLM optimization evaluation response.
 */
const evaluationSchema = z.object({
  acceptable: z.boolean(),
  issues: z.array(z.string()).optional(),
  instructions: z.string().optional(),
});

/**
 * Layer 3: LLM-based conversion optimization loop.
 *
 * Compares the original HTML against the resulting markdown and checks for:
 * - **Completeness** -- Important paragraphs, links, tables present?
 * - **Noise** -- Leftover navigation, footer links, cookie banners?
 * - **Structure** -- Headings, lists, hierarchy preserved?
 *
 * If issues are found the LLM returns improvement instructions. The markdown
 * is then post-processed according to those instructions. This repeats for
 * up to `maxIterations` cycles (default 2) to prevent infinite loops.
 *
 * Used in agent mode by default.
 *
 * @param html - The original HTML content
 * @param markdown - The initial markdown conversion result
 * @param url - The page URL for context
 * @param llm - The LLM provider
 * @param maxIterations - Maximum number of optimization iterations (default 2)
 * @returns The optimized markdown content
 */
export async function optimizeConversion(
  html: string,
  markdown: string,
  url: string,
  llm: LLMProvider,
  maxIterations: number = 2,
): Promise<string> {
  let currentMarkdown = markdown;

  // Truncate HTML for the prompt to keep it manageable
  const htmlSnippet = html.substring(0, 8000);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const evaluationPrompt = `You are evaluating a markdown conversion of an HTML page from ${url}.

Compare the original HTML against the resulting markdown and check for:
1. **Completeness**: Are important paragraphs, links, tables, and content present?
2. **Noise**: Are there leftover navigation elements, footer links, cookie banners, or ads?
3. **Structure**: Are headings, lists, and hierarchy properly preserved?

Original HTML (truncated):
\`\`\`html
${htmlSnippet}
\`\`\`

Resulting Markdown:
\`\`\`markdown
${currentMarkdown}
\`\`\`

If the markdown is acceptable, set "acceptable" to true.
If there are issues, set "acceptable" to false, list the issues, and provide specific instructions for improving the markdown (e.g., "Remove the navigation links section at the bottom", "Add the missing table from the pricing section").`;

    let evaluation: z.infer<typeof evaluationSchema>;
    try {
      evaluation = await llm.invokeStructured(
        evaluationPrompt,
        evaluationSchema,
        { callSite: 'conversion-optimizer' },
      );
    } catch {
      // On LLM error, return the best result so far
      return currentMarkdown;
    }

    if (evaluation.acceptable || !evaluation.instructions) {
      // Markdown is good enough or no actionable instructions
      return currentMarkdown;
    }

    // Apply instructions via LLM post-processing
    const improvementPrompt = `Apply the following improvements to this markdown content. Return ONLY the improved markdown, nothing else.

Instructions:
${evaluation.instructions}

Issues found:
${(evaluation.issues ?? []).join('\n')}

Current Markdown:
\`\`\`markdown
${currentMarkdown}
\`\`\`

Return the improved markdown content only, with no code fences or explanation.`;

    try {
      const improved = await llm.invoke(improvementPrompt, {
        callSite: 'conversion-optimizer',
      });

      // Only accept the improvement if it produced meaningful output
      if (improved && improved.trim().length > 0) {
        currentMarkdown = improved;
      } else {
        // Empty result -- keep current version
        return currentMarkdown;
      }
    } catch {
      // On LLM error during improvement, return best result so far
      return currentMarkdown;
    }
  }

  return currentMarkdown;
}

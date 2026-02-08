import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import type { LLMProvider } from '../llm/types.js';
import type { WebsiteFetchConfig, FetchedPage } from '../types.js';
import { selectStrategy } from '../converter/strategy-selector.js';
import { optimizeConversion } from '../converter/optimizer.js';
import { createConverter } from '../converter/index.js';
import { createLLMDescriptionProvider } from '../output/index-generator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock LLMProvider with vi.fn() stubs for invoke and invokeStructured.
 */
function createMockLLM(): LLMProvider & {
  invoke: ReturnType<typeof vi.fn>;
  invokeStructured: ReturnType<typeof vi.fn>;
} {
  return {
    invoke: vi.fn(),
    invokeStructured: vi.fn(),
  };
}

/** Create a minimal WebsiteFetchConfig for testing. */
function makeConfig(
  overrides: Partial<WebsiteFetchConfig> = {},
): WebsiteFetchConfig {
  return {
    url: 'https://example.com',
    mode: 'simple',
    maxDepth: 5,
    maxPages: 100,
    outputDir: './output',
    outputStructure: 'mirror',
    generateIndex: true,
    conversionStrategy: 'default',
    optimizeConversion: false,
    delay: 200,
    concurrency: 3,
    respectRobots: true,
    adaptiveRateLimit: true,
    ...overrides,
  };
}

/** Create a minimal FetchedPage for testing. */
function makePage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://example.com/page',
    html: '<html><body><h1>Test Page</h1><p>Content here.</p></body></html>',
    statusCode: 200,
    headers: {},
    fetchedAt: new Date(),
    markdown: '# Test Page\n\nContent here.',
    depth: 0,
    ...overrides,
  };
}

const TEST_URL = 'https://example.com/page';
const SAMPLE_HTML = '<html><body><h1>Title</h1><p>Some content here.</p></body></html>';
const SAMPLE_MARKDOWN = '# Title\n\nSome content here.';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Strategy Selector (Layer 2)
// ===========================================================================
describe('selectStrategy', () => {
  describe('returns strategy based on LLM response', () => {
    it('should return "readability" when LLM selects readability', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'readability' });

      const result = await selectStrategy(SAMPLE_HTML, TEST_URL, llm);

      expect(result).toBe('readability');
      expect(llm.invokeStructured).toHaveBeenCalledOnce();
    });

    it('should return "default" when LLM selects default', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'default' });

      const result = await selectStrategy(SAMPLE_HTML, TEST_URL, llm);

      expect(result).toBe('default');
    });
  });

  describe('uses correct call site key', () => {
    it('should pass "conversion-strategy-selector" as callSite', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'readability' });

      await selectStrategy(SAMPLE_HTML, TEST_URL, llm);

      const callArgs = llm.invokeStructured.mock.calls[0];
      // Third argument is the options object with callSite
      expect(callArgs[2]).toEqual(
        expect.objectContaining({ callSite: 'conversion-strategy-selector' }),
      );
    });
  });

  describe('truncates HTML to ~2KB for the prompt', () => {
    it('should only send the first 2000 characters of HTML', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'default' });

      // Create HTML longer than 2000 chars
      const longHtml = '<div>' + 'x'.repeat(5000) + '</div>';
      await selectStrategy(longHtml, TEST_URL, llm);

      const prompt = llm.invokeStructured.mock.calls[0][0] as string;
      // The prompt should contain the snippet, not the full 5000 chars
      expect(prompt).not.toContain('x'.repeat(5000));
      // But should contain the truncated version
      expect(prompt).toContain('x'.repeat(2000 - '<div>'.length));
    });
  });

  describe('falls back to mode default on LLM error', () => {
    it('should return "readability" (default fallback) when LLM throws', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockRejectedValueOnce(new Error('LLM API error'));

      const result = await selectStrategy(SAMPLE_HTML, TEST_URL, llm);

      expect(result).toBe('readability');
    });

    it('should return provided fallbackStrategy when LLM throws', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockRejectedValueOnce(new Error('LLM API error'));

      const result = await selectStrategy(
        SAMPLE_HTML,
        TEST_URL,
        llm,
        'default',
      );

      expect(result).toBe('default');
    });

    it('should return fallback on timeout error', async () => {
      const llm = createMockLLM();
      const timeoutError = new DOMException(
        'The operation was aborted.',
        'AbortError',
      );
      llm.invokeStructured.mockRejectedValueOnce(timeoutError);

      const result = await selectStrategy(
        SAMPLE_HTML,
        TEST_URL,
        llm,
        'readability',
      );

      expect(result).toBe('readability');
    });
  });

  describe('edge case: LLM returns unexpected strategy value', () => {
    it('should be handled by Zod schema validation (invokeStructured throws)', async () => {
      const llm = createMockLLM();
      // If the LLM somehow returns an invalid strategy, invokeStructured
      // will throw a validation error (Zod schema rejects it),
      // and selectStrategy falls back to the default.
      llm.invokeStructured.mockRejectedValueOnce(
        new Error('Validation error: Invalid enum value'),
      );

      const result = await selectStrategy(SAMPLE_HTML, TEST_URL, llm);

      // Falls back to the default fallback ('readability')
      expect(result).toBe('readability');
    });
  });

  describe('passes URL in the prompt for context', () => {
    it('should include the URL in the prompt sent to the LLM', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'default' });

      const url = 'https://docs.example.com/api/reference';
      await selectStrategy(SAMPLE_HTML, url, llm);

      const prompt = llm.invokeStructured.mock.calls[0][0] as string;
      expect(prompt).toContain(url);
    });
  });

  describe('passes Zod schema to invokeStructured', () => {
    it('should pass a schema with strategy enum to invokeStructured', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'readability' });

      await selectStrategy(SAMPLE_HTML, TEST_URL, llm);

      const schema = llm.invokeStructured.mock.calls[0][1];
      // Verify it's a ZodObject by checking it can parse valid values
      expect(schema.parse({ strategy: 'default' })).toEqual({
        strategy: 'default',
      });
      expect(schema.parse({ strategy: 'readability' })).toEqual({
        strategy: 'readability',
      });
      // And rejects invalid values
      expect(() => schema.parse({ strategy: 'invalid' })).toThrow();
    });
  });
});

// ===========================================================================
// 2. Optimizer (Layer 3)
// ===========================================================================
describe('optimizeConversion', () => {
  describe('returns original markdown when LLM reports no issues', () => {
    it('should return original markdown when evaluation is acceptable', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: true,
        issues: [],
        instructions: undefined,
      });

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      expect(result).toBe(SAMPLE_MARKDOWN);
      // Should only call invokeStructured once (evaluation), no improvement call
      expect(llm.invokeStructured).toHaveBeenCalledOnce();
      expect(llm.invoke).not.toHaveBeenCalled();
    });

    it('should return original markdown when no instructions provided', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Missing table'],
        instructions: undefined,
      });

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      expect(result).toBe(SAMPLE_MARKDOWN);
    });
  });

  describe('improves markdown when LLM identifies issues', () => {
    it('should apply LLM improvements and return improved markdown', async () => {
      const llm = createMockLLM();
      const improvedMarkdown =
        '# Title\n\nSome content here.\n\n| Col A | Col B |\n| --- | --- |\n| 1 | 2 |';

      // First call: evaluation finds issues
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Missing table from the page'],
        instructions: 'Add the missing table with columns A and B',
      });

      // Second call: LLM returns improved markdown
      llm.invoke.mockResolvedValueOnce(improvedMarkdown);

      // Third call: re-evaluation says it's acceptable now
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: true,
        issues: [],
      });

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      expect(result).toBe(improvedMarkdown);
      // One evaluation + one improvement + one re-evaluation
      expect(llm.invokeStructured).toHaveBeenCalledTimes(2);
      expect(llm.invoke).toHaveBeenCalledOnce();
    });
  });

  describe('stops after max iterations', () => {
    it('should stop after maxIterations even if issues remain', async () => {
      const llm = createMockLLM();

      // Every evaluation finds issues, every improvement works
      llm.invokeStructured.mockResolvedValue({
        acceptable: false,
        issues: ['Still has issues'],
        instructions: 'Fix the remaining issues',
      });
      llm.invoke.mockResolvedValue('Improved markdown v1');

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
        2, // max 2 iterations
      );

      // Should have done 2 iterations (2 evaluations + 2 improvements)
      expect(llm.invokeStructured).toHaveBeenCalledTimes(2);
      expect(llm.invoke).toHaveBeenCalledTimes(2);
      // Should return the last improved version
      expect(result).toBe('Improved markdown v1');
    });

    it('should stop after 1 iteration when maxIterations is 1', async () => {
      const llm = createMockLLM();

      llm.invokeStructured.mockResolvedValue({
        acceptable: false,
        issues: ['Issue found'],
        instructions: 'Apply fix',
      });
      llm.invoke.mockResolvedValue('Fixed markdown');

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
        1,
      );

      expect(llm.invokeStructured).toHaveBeenCalledTimes(1);
      expect(llm.invoke).toHaveBeenCalledTimes(1);
      expect(result).toBe('Fixed markdown');
    });

    it('should return original markdown when maxIterations is 0', async () => {
      const llm = createMockLLM();

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
        0,
      );

      // No LLM calls should be made
      expect(llm.invokeStructured).not.toHaveBeenCalled();
      expect(llm.invoke).not.toHaveBeenCalled();
      expect(result).toBe(SAMPLE_MARKDOWN);
    });
  });

  describe('uses correct call site key', () => {
    it('should use "conversion-optimizer" for evaluation calls', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: true,
      });

      await optimizeConversion(SAMPLE_HTML, SAMPLE_MARKDOWN, TEST_URL, llm);

      const evalOptions = llm.invokeStructured.mock.calls[0][2];
      expect(evalOptions).toEqual(
        expect.objectContaining({ callSite: 'conversion-optimizer' }),
      );
    });

    it('should use "conversion-optimizer" for improvement calls', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Issue'],
        instructions: 'Fix it',
      });
      llm.invoke.mockResolvedValueOnce('Improved markdown');
      llm.invokeStructured.mockResolvedValueOnce({ acceptable: true });

      await optimizeConversion(SAMPLE_HTML, SAMPLE_MARKDOWN, TEST_URL, llm);

      const improveOptions = llm.invoke.mock.calls[0][1];
      expect(improveOptions).toEqual(
        expect.objectContaining({ callSite: 'conversion-optimizer' }),
      );
    });
  });

  describe('truncates HTML to ~8KB for the prompt', () => {
    it('should truncate HTML in the evaluation prompt', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ acceptable: true });

      const longHtml = '<div>' + 'y'.repeat(20000) + '</div>';
      await optimizeConversion(longHtml, SAMPLE_MARKDOWN, TEST_URL, llm);

      const prompt = llm.invokeStructured.mock.calls[0][0] as string;
      // Should not contain the full 20000 chars
      expect(prompt).not.toContain('y'.repeat(20000));
      // But should contain up to 8000 chars of the HTML
      expect(prompt).toContain('y'.repeat(8000 - '<div>'.length));
    });
  });

  describe('edge case: LLM error during evaluation', () => {
    it('should return current markdown on evaluation error', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockRejectedValueOnce(new Error('LLM API down'));

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      expect(result).toBe(SAMPLE_MARKDOWN);
    });
  });

  describe('edge case: LLM error during improvement', () => {
    it('should return best result so far when improvement call fails', async () => {
      const llm = createMockLLM();

      // Evaluation finds issues
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Missing content'],
        instructions: 'Add the missing section',
      });

      // Improvement call fails
      llm.invoke.mockRejectedValueOnce(new Error('LLM timeout'));

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      // Should return the original markdown (best so far before failure)
      expect(result).toBe(SAMPLE_MARKDOWN);
    });
  });

  describe('edge case: LLM timeout during optimization', () => {
    it('should return best result so far on timeout during second iteration', async () => {
      const llm = createMockLLM();
      const firstImproved = '# Title\n\nImproved content v1.';

      // First iteration: evaluation finds issues, improvement succeeds
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Missing section'],
        instructions: 'Add the missing section',
      });
      llm.invoke.mockResolvedValueOnce(firstImproved);

      // Second iteration: evaluation times out
      const timeoutError = new DOMException('Aborted', 'AbortError');
      llm.invokeStructured.mockRejectedValueOnce(timeoutError);

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
        2,
      );

      // Should return the first improvement (best result so far)
      expect(result).toBe(firstImproved);
    });
  });

  describe('edge case: improvement produces empty result', () => {
    it('should return current markdown when LLM returns empty string', async () => {
      const llm = createMockLLM();

      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Issue'],
        instructions: 'Fix it',
      });
      // LLM returns empty result
      llm.invoke.mockResolvedValueOnce('');

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      expect(result).toBe(SAMPLE_MARKDOWN);
    });

    it('should return current markdown when LLM returns whitespace-only', async () => {
      const llm = createMockLLM();

      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Issue'],
        instructions: 'Fix it',
      });
      llm.invoke.mockResolvedValueOnce('   \n\t  ');

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
      );

      expect(result).toBe(SAMPLE_MARKDOWN);
    });
  });

  describe('evaluation schema validation', () => {
    it('should use a Zod schema with acceptable, issues, and instructions fields', async () => {
      const llm = createMockLLM();
      llm.invokeStructured.mockResolvedValueOnce({ acceptable: true });

      await optimizeConversion(SAMPLE_HTML, SAMPLE_MARKDOWN, TEST_URL, llm);

      const schema = llm.invokeStructured.mock.calls[0][1];
      // Verify the schema can parse valid evaluation objects
      expect(
        schema.parse({
          acceptable: true,
          issues: [],
          instructions: 'none',
        }),
      ).toEqual({
        acceptable: true,
        issues: [],
        instructions: 'none',
      });
      expect(schema.parse({ acceptable: false })).toEqual({
        acceptable: false,
      });
    });
  });

  describe('multi-iteration improvement', () => {
    it('should pass the improved markdown from iteration 1 into iteration 2', async () => {
      const llm = createMockLLM();
      const v1Improved = '# Title\n\nImproved v1';
      const v2Improved = '# Title\n\nImproved v2 (even better)';

      // Iteration 1: finds issues, improves
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Missing section'],
        instructions: 'Add section',
      });
      llm.invoke.mockResolvedValueOnce(v1Improved);

      // Iteration 2: finds more issues, improves again
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: false,
        issues: ['Formatting issue'],
        instructions: 'Fix formatting',
      });
      llm.invoke.mockResolvedValueOnce(v2Improved);

      const result = await optimizeConversion(
        SAMPLE_HTML,
        SAMPLE_MARKDOWN,
        TEST_URL,
        llm,
        2,
      );

      expect(result).toBe(v2Improved);

      // Verify the second evaluation prompt contains the v1 improved markdown
      const secondEvalPrompt = llm.invokeStructured.mock.calls[1][0] as string;
      expect(secondEvalPrompt).toContain(v1Improved);
    });
  });
});

// ===========================================================================
// 3. createLLMDescriptionProvider (Index Generator)
// ===========================================================================
describe('createLLMDescriptionProvider', () => {
  describe('generates one-sentence descriptions', () => {
    it('should return a trimmed description from LLM', async () => {
      const llm = createMockLLM();
      llm.invoke.mockResolvedValueOnce(
        '  A comprehensive guide to JavaScript closures.  ',
      );

      const provider = createLLMDescriptionProvider(llm);
      const page = makePage({
        url: 'https://example.com/closures',
        markdown: '# Closures\n\nA closure is...',
      });

      const description = await provider(page);

      expect(description).toBe(
        'A comprehensive guide to JavaScript closures.',
      );
    });
  });

  describe('uses correct call site key', () => {
    it('should pass "index-generator" as callSite', async () => {
      const llm = createMockLLM();
      llm.invoke.mockResolvedValueOnce('Description text.');

      const provider = createLLMDescriptionProvider(llm);
      await provider(makePage());

      const callOptions = llm.invoke.mock.calls[0][1];
      expect(callOptions).toEqual(
        expect.objectContaining({ callSite: 'index-generator' }),
      );
    });
  });

  describe('truncates markdown to ~2KB for the prompt', () => {
    it('should only send the first 2000 characters of markdown', async () => {
      const llm = createMockLLM();
      llm.invoke.mockResolvedValueOnce('Description.');

      const longMarkdown = '# Title\n\n' + 'a'.repeat(5000);
      const provider = createLLMDescriptionProvider(llm);
      await provider(makePage({ markdown: longMarkdown }));

      const prompt = llm.invoke.mock.calls[0][0] as string;
      // Should not contain the full 5000 chars
      expect(prompt).not.toContain('a'.repeat(5000));
    });
  });

  describe('includes URL in the prompt', () => {
    it('should include the page URL for context', async () => {
      const llm = createMockLLM();
      llm.invoke.mockResolvedValueOnce('Page description.');

      const provider = createLLMDescriptionProvider(llm);
      const url = 'https://docs.example.com/api/auth';
      await provider(makePage({ url }));

      const prompt = llm.invoke.mock.calls[0][0] as string;
      expect(prompt).toContain(url);
    });
  });

  describe('propagates errors to caller', () => {
    it('should let LLM errors propagate (IndexGenerator catches them)', async () => {
      const llm = createMockLLM();
      llm.invoke.mockRejectedValueOnce(new Error('LLM service unavailable'));

      const provider = createLLMDescriptionProvider(llm);

      await expect(provider(makePage())).rejects.toThrow(
        'LLM service unavailable',
      );
    });
  });
});

// ===========================================================================
// 4. createConverter pipeline (mode-based layer wiring)
// ===========================================================================
describe('createConverter with LLM layers', () => {
  describe('simple mode: Layer 1 only (no LLM)', () => {
    it('should not call LLM for strategy selection or optimization', async () => {
      const llm = createMockLLM();
      const converter = createConverter(
        makeConfig({
          mode: 'simple',
          conversionStrategy: 'default',
          llmProvider: llm,
        }),
      );

      const result = await converter.convert(
        '<h1>Hello</h1><p>World</p>',
        TEST_URL,
      );

      expect(result).toContain('# Hello');
      expect(result).toContain('World');
      // No LLM calls in simple mode
      expect(llm.invokeStructured).not.toHaveBeenCalled();
      expect(llm.invoke).not.toHaveBeenCalled();
    });
  });

  describe('smart mode: Layers 1+2 (strategy selection, no optimization)', () => {
    it('should call LLM for strategy selection but not optimization', async () => {
      const llm = createMockLLM();
      // LLM selects 'default' strategy
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'default' });

      const converter = createConverter(
        makeConfig({
          mode: 'smart',
          conversionStrategy: 'readability',
          llmProvider: llm,
        }),
      );

      const result = await converter.convert(
        '<h1>Hello</h1><p>World</p>',
        TEST_URL,
      );

      expect(result).toContain('Hello');
      // Strategy selector was called
      expect(llm.invokeStructured).toHaveBeenCalledOnce();
      // Optimizer was NOT called (smart mode default = useOptimizer: false)
      expect(llm.invoke).not.toHaveBeenCalled();
    });
  });

  describe('agent mode: Layers 1+2+3 (strategy selection + optimization)', () => {
    it('should call LLM for both strategy selection and optimization', async () => {
      const llm = createMockLLM();
      // Layer 2: LLM selects 'readability' strategy
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'readability' });
      // Layer 3: LLM evaluates and says it's acceptable
      llm.invokeStructured.mockResolvedValueOnce({
        acceptable: true,
      });

      const html = `<!DOCTYPE html><html><head><title>Test</title></head><body>
        <article>
          <h1>Agent Mode Test</h1>
          <p>This is a substantial article with enough text for Readability
          to recognize it as the main content. We need multiple paragraphs.</p>
          <p>Second paragraph provides more detail about the topic at hand.</p>
          <p>Third paragraph ensures content density is sufficient for processing.</p>
        </article>
      </body></html>`;

      const converter = createConverter(
        makeConfig({
          mode: 'agent',
          conversionStrategy: 'readability',
          llmProvider: llm,
        }),
      );

      await converter.convert(html, TEST_URL);

      // Strategy selector called (Layer 2)
      // Optimizer evaluation called (Layer 3)
      expect(llm.invokeStructured).toHaveBeenCalledTimes(2);
    });
  });

  describe('smart mode without LLM provider: Layer 1 only', () => {
    it('should not call LLM when no llmProvider is configured', async () => {
      const converter = createConverter(
        makeConfig({
          mode: 'smart',
          conversionStrategy: 'readability',
          // No llmProvider
        }),
      );

      const html = `<!DOCTYPE html><html><head><title>Test</title></head><body>
        <article>
          <h1>No LLM Test</h1>
          <p>This article has enough content for Readability to work with.
          Multiple paragraphs ensure proper content extraction.</p>
          <p>Second paragraph adds more text to help Readability identify
          the main content area of the page.</p>
          <p>Third paragraph for additional content density and heuristics.</p>
        </article>
      </body></html>`;

      const result = await converter.convert(html, TEST_URL);

      // Should still produce output using the configured strategy
      expect(result).toContain('No LLM Test');
    });
  });

  describe('custom strategy bypasses Layer 2', () => {
    it('should not call LLM for strategy selection with custom strategy', async () => {
      const llm = createMockLLM();
      const customFn = vi.fn().mockResolvedValue('# Custom Output');

      const converter = createConverter(
        makeConfig({
          mode: 'agent',
          conversionStrategy: 'custom',
          customConverter: customFn,
          llmProvider: llm,
        }),
      );

      // Layer 3 evaluation says it's acceptable
      llm.invokeStructured.mockResolvedValueOnce({ acceptable: true });

      await converter.convert(SAMPLE_HTML, TEST_URL);

      // Custom converter was called
      expect(customFn).toHaveBeenCalled();

      // invokeStructured should be called ONLY for the optimizer evaluation (Layer 3),
      // NOT for strategy selection (Layer 2)
      expect(llm.invokeStructured).toHaveBeenCalledOnce();
      const callSite = llm.invokeStructured.mock.calls[0][2]?.callSite;
      expect(callSite).toBe('conversion-optimizer');
    });
  });

  describe('optimizeConversion config override', () => {
    it('should enable optimization in smart mode when optimizeConversion is true', async () => {
      const llm = createMockLLM();
      // Layer 2: strategy selection
      llm.invokeStructured.mockResolvedValueOnce({ strategy: 'default' });
      // Layer 3: optimization evaluation (says acceptable)
      llm.invokeStructured.mockResolvedValueOnce({ acceptable: true });

      const converter = createConverter(
        makeConfig({
          mode: 'smart',
          conversionStrategy: 'readability',
          optimizeConversion: true, // Override: enable Layer 3 in smart mode
          llmProvider: llm,
        }),
      );

      await converter.convert('<h1>Test</h1><p>Content</p>', TEST_URL);

      // Both strategy selector AND optimizer should be called
      expect(llm.invokeStructured).toHaveBeenCalledTimes(2);
    });
  });
});

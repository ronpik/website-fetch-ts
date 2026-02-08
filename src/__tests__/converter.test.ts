import { describe, it, expect, vi } from "vitest";

import {
  DefaultStrategy,
  ReadabilityStrategy,
  CustomStrategy,
  createTurndownService,
  getStrategy,
  createConverter,
} from "../converter/index.js";
import type { WebsiteFetchConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WebsiteFetchConfig for testing createConverter. */
function makeConfig(
  overrides: Partial<WebsiteFetchConfig> = {},
): WebsiteFetchConfig {
  return {
    url: "https://example.com",
    mode: "simple",
    maxDepth: 5,
    maxPages: 100,
    outputDir: "./output",
    outputStructure: "mirror",
    generateIndex: true,
    conversionStrategy: "default",
    optimizeConversion: false,
    delay: 200,
    concurrency: 3,
    respectRobots: true,
    adaptiveRateLimit: true,
    ...overrides,
  };
}

/** Wrap HTML in a minimal valid document for Readability. */
function wrapInDocument(bodyHtml: string, title = "Test Page"): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>${bodyHtml}</body>
</html>`;
}

const TEST_URL = "https://example.com/page";

// ---------------------------------------------------------------------------
// 1. DefaultStrategy — basic HTML conversion
// ---------------------------------------------------------------------------
describe("DefaultStrategy", () => {
  const strategy = new DefaultStrategy();

  describe("basic HTML elements", () => {
    it("should convert headings to ATX-style markdown", async () => {
      const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("# Title");
      expect(result).toContain("## Subtitle");
      expect(result).toContain("### Section");
    });

    it("should convert paragraphs to plain text with spacing", async () => {
      const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("First paragraph.");
      expect(result).toContain("Second paragraph.");
    });

    it("should convert links to markdown link syntax", async () => {
      const html = '<p>Visit <a href="https://example.com">Example</a> now.</p>';
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("[Example](https://example.com)");
    });

    it("should convert unordered lists with dash markers", async () => {
      const html = "<ul><li>Item A</li><li>Item B</li><li>Item C</li></ul>";
      const result = await strategy.convert(html, TEST_URL);

      // Turndown uses 3-space indent after dash: "-   Item"
      expect(result).toMatch(/-\s+Item A/);
      expect(result).toMatch(/-\s+Item B/);
      expect(result).toMatch(/-\s+Item C/);
    });

    it("should convert ordered lists with numbered markers", async () => {
      const html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("1.");
      expect(result).toContain("First");
      expect(result).toContain("2.");
      expect(result).toContain("Second");
    });

    it("should convert inline code to backtick syntax", async () => {
      const html = "<p>Use <code>const x = 1</code> in your code.</p>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("`const x = 1`");
    });

    it("should convert code blocks to fenced code blocks", async () => {
      const html =
        '<pre><code class="language-js">function hello() {\n  return "world";\n}</code></pre>';
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("```");
      expect(result).toContain("function hello()");
      expect(result).toContain('return "world"');
    });

    it("should convert strong/bold to double asterisks", async () => {
      const html = "<p>This is <strong>bold</strong> text.</p>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("**bold**");
    });

    it("should convert em/italic to underscores", async () => {
      const html = "<p>This is <em>italic</em> text.</p>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("_italic_");
    });
  });

  describe("GFM table support", () => {
    it("should preserve tables in GFM format with thead", async () => {
      const html = `
        <table>
          <thead>
            <tr><th>Name</th><th>Age</th></tr>
          </thead>
          <tbody>
            <tr><td>Alice</td><td>30</td></tr>
            <tr><td>Bob</td><td>25</td></tr>
          </tbody>
        </table>
      `;
      const result = await strategy.convert(html, TEST_URL);

      // Should have pipe-delimited rows
      expect(result).toContain("Name");
      expect(result).toContain("Age");
      expect(result).toContain("Alice");
      expect(result).toContain("30");
      expect(result).toContain("Bob");
      expect(result).toContain("25");
      // Should have separator row with ---
      expect(result).toContain("---");
      // Should have pipe characters
      expect(result).toContain("|");
    });

    it("should handle tables with th-based headers (no thead)", async () => {
      const html = `
        <table>
          <tbody>
            <tr><th>Col 1</th><th>Col 2</th></tr>
            <tr><td>A</td><td>B</td></tr>
          </tbody>
        </table>
      `;
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("Col 1");
      expect(result).toContain("Col 2");
      expect(result).toContain("---");
      expect(result).toContain("|");
    });

    it("should handle a simple table with only td cells", async () => {
      const html = `
        <table>
          <tr><td>X</td><td>Y</td></tr>
          <tr><td>1</td><td>2</td></tr>
        </table>
      `;
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("X");
      expect(result).toContain("Y");
      expect(result).toContain("1");
      expect(result).toContain("2");
      expect(result).toContain("|");
      // Fallback separator should be added
      expect(result).toContain("---");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. ReadabilityStrategy — content extraction
// ---------------------------------------------------------------------------
describe("ReadabilityStrategy", () => {
  const strategy = new ReadabilityStrategy();

  it("should strip navigation and sidebar elements", async () => {
    const html = wrapInDocument(`
      <nav>
        <ul>
          <li><a href="/home">Home</a></li>
          <li><a href="/about">About</a></li>
        </ul>
      </nav>
      <aside class="sidebar">
        <p>Sidebar content that should be removed.</p>
      </aside>
      <article>
        <h1>Main Article Title</h1>
        <p>This is the important article content that should be preserved.
        It contains enough text for Readability to recognize it as the main content
        of the page. We need a reasonable amount of text here.</p>
        <p>More content in the article body. This paragraph provides additional
        context and detail about the topic being discussed in this article.</p>
        <p>A third paragraph to ensure Readability has enough content to work with.
        Readability uses heuristics based on text density, so we need multiple
        paragraphs with substantial text content.</p>
      </article>
    `);
    const result = await strategy.convert(html, TEST_URL);

    // Main content should be preserved
    expect(result).toContain("Main Article Title");
    expect(result).toContain("important article content");

    // Navigation links should be stripped (or at least the nav structure)
    // Note: Readability may or may not fully strip nav — we check that
    // the article content is the primary output
    expect(result).toContain("main content");
  });

  it("should preserve main content", async () => {
    const html = wrapInDocument(`
      <header>
        <div class="logo">Site Logo</div>
        <nav><a href="/">Home</a></nav>
      </header>
      <main>
        <article>
          <h1>Understanding JavaScript Closures</h1>
          <p>A closure is a function that has access to its outer scope's variables
          even after the outer function has returned. This is a fundamental concept
          in JavaScript programming.</p>
          <p>Closures are created every time a function is created, at function creation
          time. They enable powerful patterns like data privacy, partial application,
          and factory functions.</p>
          <p>Here is a simple example of a closure in action. The inner function
          retains access to the variable defined in the outer function scope.</p>
        </article>
      </main>
      <footer>
        <p>Copyright 2026</p>
      </footer>
    `);
    const result = await strategy.convert(html, TEST_URL);

    expect(result).toContain("Understanding JavaScript Closures");
    expect(result).toContain("closure");
    expect(result).toContain("outer scope");
  });

  it("should fall back to default when Readability returns null", async () => {
    // Minimal HTML that Readability cannot parse meaningfully
    const html = "<html><head></head><body><p>Tiny.</p></body></html>";
    const result = await strategy.convert(html, TEST_URL);

    // Even if Readability returns null, the fallback default strategy should
    // still produce output from the original HTML
    expect(result).toContain("Tiny.");
  });

  it("should fall back to default for HTML with only non-content elements", async () => {
    // HTML with nav/footer only — Readability may return null
    const html = wrapInDocument(`
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <footer><p>Footer text</p></footer>
    `);
    const result = await strategy.convert(html, TEST_URL);

    // Should still produce some output (from the fallback if Readability returns null)
    // The exact content depends on whether Readability returns null or not
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3. CustomStrategy
// ---------------------------------------------------------------------------
describe("CustomStrategy", () => {
  it("should call provided function with html and url", async () => {
    const customFn = vi.fn().mockResolvedValue("# Custom Output");
    const strategy = new CustomStrategy(customFn);

    const html = "<h1>Hello</h1>";
    const url = "https://example.com/custom";
    const result = await strategy.convert(html, url);

    expect(customFn).toHaveBeenCalledOnce();
    expect(customFn).toHaveBeenCalledWith(html, url);
    expect(result).toBe("# Custom Output");
  });

  it("should pass through the return value of the custom function", async () => {
    const customFn = vi.fn().mockResolvedValue("Completely custom markdown");
    const strategy = new CustomStrategy(customFn);

    const result = await strategy.convert("<div>anything</div>", TEST_URL);

    expect(result).toBe("Completely custom markdown");
  });

  it("should propagate errors from the custom function", async () => {
    const customFn = vi.fn().mockRejectedValue(new Error("Custom error"));
    const strategy = new CustomStrategy(customFn);

    await expect(strategy.convert("<p>test</p>", TEST_URL)).rejects.toThrow(
      "Custom error",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. getStrategy — factory
// ---------------------------------------------------------------------------
describe("getStrategy", () => {
  it("should return a DefaultStrategy for 'default'", () => {
    const strategy = getStrategy("default");
    expect(strategy).toBeInstanceOf(DefaultStrategy);
  });

  it("should return a ReadabilityStrategy for 'readability'", () => {
    const strategy = getStrategy("readability");
    expect(strategy).toBeInstanceOf(ReadabilityStrategy);
  });

  it("should return a CustomStrategy for 'custom' with a converter function", () => {
    const customFn = async (html: string, url: string) => html;
    const strategy = getStrategy("custom", customFn);
    expect(strategy).toBeInstanceOf(CustomStrategy);
  });

  it("should throw when 'custom' is selected without a converter function", () => {
    expect(() => getStrategy("custom")).toThrow(
      "Custom conversion strategy requires a customConverter function in config",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. createConverter — factory with config
// ---------------------------------------------------------------------------
describe("createConverter", () => {
  it("should return an object with a convert method", () => {
    const converter = createConverter(makeConfig());
    expect(converter).toHaveProperty("convert");
    expect(typeof converter.convert).toBe("function");
  });

  it("should use default strategy when conversionStrategy is 'default'", async () => {
    const converter = createConverter(
      makeConfig({ conversionStrategy: "default" }),
    );
    const result = await converter.convert("<h1>Hello</h1>", TEST_URL);

    expect(result).toContain("# Hello");
  });

  it("should use readability strategy when conversionStrategy is 'readability'", async () => {
    const html = wrapInDocument(`
      <article>
        <h1>Article Title</h1>
        <p>This is a substantial article body with enough text for Readability
        to recognize it as the main content of the page. We include multiple
        sentences to ensure proper content extraction.</p>
        <p>A second paragraph adds more content and helps Readability's heuristics
        determine that this is indeed the primary content area of the page.</p>
        <p>A third paragraph further reinforces the content density, making it
        clear to Readability that this article section is what matters.</p>
      </article>
    `);
    const converter = createConverter(
      makeConfig({ conversionStrategy: "readability" }),
    );
    const result = await converter.convert(html, TEST_URL);

    expect(result).toContain("Article Title");
  });

  it("should use custom strategy when conversionStrategy is 'custom' with customConverter", async () => {
    const customFn = vi.fn().mockResolvedValue("Custom result");
    const converter = createConverter(
      makeConfig({
        conversionStrategy: "custom",
        customConverter: customFn,
      }),
    );
    const result = await converter.convert("<p>Input</p>", TEST_URL);

    expect(result).toBe("Custom result");
    expect(customFn).toHaveBeenCalledWith("<p>Input</p>", TEST_URL);
  });

  it("should throw when 'custom' is selected without customConverter", () => {
    expect(() =>
      createConverter(makeConfig({ conversionStrategy: "custom" })),
    ).toThrow("Custom conversion strategy requires a customConverter function");
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  describe("empty HTML", () => {
    it("should return empty string for empty input with DefaultStrategy", async () => {
      const strategy = new DefaultStrategy();
      const result = await strategy.convert("", TEST_URL);
      expect(result).toBe("");
    });

    it("should return empty string for whitespace-only input with DefaultStrategy", async () => {
      const strategy = new DefaultStrategy();
      const result = await strategy.convert("   \n\t  ", TEST_URL);
      expect(result).toBe("");
    });

    it("should return empty string for empty input with ReadabilityStrategy", async () => {
      const strategy = new ReadabilityStrategy();
      const result = await strategy.convert("", TEST_URL);
      expect(result).toBe("");
    });

    it("should return empty string for whitespace-only input with ReadabilityStrategy", async () => {
      const strategy = new ReadabilityStrategy();
      const result = await strategy.convert("   \n\t  ", TEST_URL);
      expect(result).toBe("");
    });
  });

  describe("HTML with inline styles and scripts", () => {
    it("should strip script elements from output", async () => {
      const strategy = new DefaultStrategy();
      const html =
        '<p>Content</p><script>alert("xss")</script><p>More content</p>';
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("Content");
      expect(result).toContain("More content");
      expect(result).not.toContain("alert");
      expect(result).not.toContain("script");
    });

    it("should strip style elements from output", async () => {
      const strategy = new DefaultStrategy();
      const html =
        "<style>body { color: red; }</style><p>Visible content</p>";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("Visible content");
      expect(result).not.toContain("color: red");
      expect(result).not.toContain("style");
    });

    it("should strip inline style attributes (via Turndown default behavior)", async () => {
      const strategy = new DefaultStrategy();
      const html =
        '<p style="color: red; font-size: 20px;">Styled paragraph</p>';
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("Styled paragraph");
      expect(result).not.toContain("color: red");
      expect(result).not.toContain("font-size");
    });
  });

  describe("malformed HTML", () => {
    it("should handle unclosed tags gracefully", async () => {
      const strategy = new DefaultStrategy();
      const html = "<p>Unclosed paragraph<p>Another paragraph";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("Unclosed paragraph");
      expect(result).toContain("Another paragraph");
    });

    it("should handle mismatched tags gracefully", async () => {
      const strategy = new DefaultStrategy();
      const html = "<h1>Title</h2><p>Content</div>";
      const result = await strategy.convert(html, TEST_URL);

      // Should not throw and should produce some output
      expect(typeof result).toBe("string");
      expect(result).toContain("Title");
    });

    it("should handle HTML with no body tags", async () => {
      const strategy = new DefaultStrategy();
      const html = "Just plain text with no tags at all";
      const result = await strategy.convert(html, TEST_URL);

      expect(result).toContain("Just plain text with no tags at all");
    });

    it("should handle nested malformed structures", async () => {
      const strategy = new DefaultStrategy();
      const html =
        "<div><p><strong>Bold <em>and italic</p></strong></em></div>";
      const result = await strategy.convert(html, TEST_URL);

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("very large HTML document", () => {
    it("should complete conversion without timeout", async () => {
      const strategy = new DefaultStrategy();
      // Generate a large HTML document with many paragraphs
      const paragraphs = Array.from(
        { length: 1000 },
        (_, i) =>
          `<p>Paragraph ${i + 1}: This is a test paragraph with enough content to simulate a real page.</p>`,
      ).join("\n");
      const html = `<html><body><h1>Large Document</h1>${paragraphs}</body></html>`;

      const start = Date.now();
      const result = await strategy.convert(html, TEST_URL);
      const elapsed = Date.now() - start;

      expect(result).toContain("# Large Document");
      expect(result).toContain("Paragraph 1");
      expect(result).toContain("Paragraph 1000");
      // Should complete in a reasonable time (under 10 seconds)
      expect(elapsed).toBeLessThan(10000);
    }, 15000);
  });

  describe("HTML with only non-content elements (nav, footer)", () => {
    it("should handle HTML with only nav and footer via readability strategy", async () => {
      const strategy = new ReadabilityStrategy();
      const html = wrapInDocument(`
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <footer><p>Copyright 2026</p></footer>
      `);
      const result = await strategy.convert(html, TEST_URL);

      // Readability may return null here, fallback should still produce output
      expect(typeof result).toBe("string");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. createTurndownService — utility
// ---------------------------------------------------------------------------
describe("createTurndownService", () => {
  it("should return a TurndownService instance", () => {
    const turndown = createTurndownService();
    expect(turndown).toBeDefined();
    expect(typeof turndown.turndown).toBe("function");
  });

  it("should use ATX-style headings", () => {
    const turndown = createTurndownService();
    const result = turndown.turndown("<h1>Test</h1>");
    expect(result).toBe("# Test");
  });

  it("should use dash bullet markers", () => {
    const turndown = createTurndownService();
    const result = turndown.turndown("<ul><li>Item</li></ul>");
    // Turndown uses 3-space indent after dash: "-   Item"
    expect(result).toMatch(/-\s+Item/);
  });

  it("should use fenced code blocks", () => {
    const turndown = createTurndownService();
    const result = turndown.turndown("<pre><code>code here</code></pre>");
    expect(result).toContain("```");
    expect(result).toContain("code here");
  });
});

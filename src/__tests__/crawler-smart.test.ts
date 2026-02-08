import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmartCrawler } from "../crawler/smart.js";
import type { Fetcher } from "../fetcher/index.js";
import type { Converter } from "../converter/index.js";
import type { OutputWriter } from "../output/index.js";
import type { LLMProvider } from "../llm/types.js";
import type { WebsiteFetchConfig, FetchedPageRaw } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WebsiteFetchConfig for testing. */
function makeConfig(
  overrides: Partial<WebsiteFetchConfig> = {},
): WebsiteFetchConfig {
  return {
    url: "https://example.com",
    mode: "smart",
    maxDepth: 5,
    maxPages: 100,
    outputDir: "./output",
    outputStructure: "mirror",
    generateIndex: true,
    conversionStrategy: "readability",
    optimizeConversion: false,
    delay: 0,
    concurrency: 3,
    respectRobots: false,
    adaptiveRateLimit: false,
    linkClassification: "batch",
    ...overrides,
  };
}

/** Create a mock FetchedPageRaw result for a given URL. */
function makeFetchedPageRaw(url: string, html: string): FetchedPageRaw {
  return {
    url,
    html,
    statusCode: 200,
    headers: { "content-type": "text/html" },
    fetchedAt: new Date(),
  };
}

/**
 * Build a simple HTML page with anchor links.
 * Each link includes context text in a surrounding paragraph.
 */
function makeHtml(
  links: Array<string | { href: string; text: string; context: string }>,
): string {
  const anchors = links
    .map((link) => {
      if (typeof link === "string") {
        return `<p>See <a href="${link}">Link to ${link}</a> for more information</p>`;
      }
      return `<p>${link.context} <a href="${link.href}">${link.text}</a></p>`;
    })
    .join("\n");
  return `<html><body><h1>Page</h1>${anchors}</body></html>`;
}

/** Create a mock Fetcher that returns predetermined responses. */
function createMockFetcher(
  responses: Record<string, { html: string } | Error>,
): Fetcher {
  return {
    fetch: vi.fn(async (url: string): Promise<FetchedPageRaw> => {
      const response = responses[url];
      if (!response) {
        throw new Error(`No mock response for URL: ${url}`);
      }
      if (response instanceof Error) {
        throw response;
      }
      return makeFetchedPageRaw(url, response.html);
    }),
    isAllowed: vi.fn(async () => true),
    getCrawlDelay: vi.fn(() => undefined),
    close: vi.fn(),
  };
}

/** Create a mock Converter that returns simple markdown. */
function createMockConverter(): Converter {
  return {
    convert: vi.fn(async (_html: string, url: string) => {
      return `# Converted: ${url}`;
    }),
  };
}

/** Create a mock OutputWriter. */
function createMockOutputWriter(): OutputWriter {
  return {
    writePage: vi.fn(async () => "output/path.md"),
    urlToFilePath: vi.fn((url: string) => `output/${url}`),
  };
}

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

// ---------------------------------------------------------------------------
// SmartCrawler Tests
// ---------------------------------------------------------------------------
describe("SmartCrawler", () => {
  let mockConverter: Converter;
  let mockOutputWriter: OutputWriter;
  let mockLLM: ReturnType<typeof createMockLLM>;

  beforeEach(() => {
    mockConverter = createMockConverter();
    mockOutputWriter = createMockOutputWriter();
    mockLLM = createMockLLM();
  });

  // -------------------------------------------------------------------------
  // Batch classification
  // -------------------------------------------------------------------------
  describe("batch classification", () => {
    it("should only queue LLM-approved links", async () => {
      // Root page has 3 links. LLM approves only links 1 and 3.
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/api/auth",
            "https://example.com/blog/recap",
            "https://example.com/api/endpoints",
          ]),
        },
        "https://example.com/api/auth": {
          html: makeHtml([]),
        },
        "https://example.com/blog/recap": {
          html: makeHtml([]),
        },
        "https://example.com/api/endpoints": {
          html: makeHtml([]),
        },
      });

      // LLM returns links 1 and 3 as relevant (1-indexed)
      mockLLM.invokeStructured.mockResolvedValue({
        relevant: [1, 3],
      });

      const config = makeConfig({
        url: "https://example.com",
        linkClassification: "batch",
      });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Fetch all API documentation",
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/api/auth");
      expect(urls).toContain("https://example.com/api/endpoints");
      // Blog link should NOT be fetched (LLM did not approve it)
      expect(urls).not.toContain("https://example.com/blog/recap");
    });

    it("should use 'link-classifier' as callSite for batch classification", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": {
          html: makeHtml([]),
        },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test description",
      );

      await crawler.crawl();

      // Verify callSite is 'link-classifier'
      expect(mockLLM.invokeStructured).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ callSite: "link-classifier" }),
      );
    });

    it("should include description and link URL in batch classification prompt", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            {
              href: "https://example.com/docs/api",
              text: "API Docs",
              context: "See the authentication guide for setting up API keys",
            },
          ]),
        },
        "https://example.com/docs/api": {
          html: makeHtml([]),
        },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const description = "Fetch all API documentation";
      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        description,
      );

      await crawler.crawl();

      const prompt = mockLLM.invokeStructured.mock.calls[0][0] as string;
      // Prompt should include the description
      expect(prompt).toContain(description);
      // Prompt should include the link URL
      expect(prompt).toContain("https://example.com/docs/api");
      // Prompt should include context from link
      expect(prompt).toContain("authentication guide");
    });

    it("should filter invalid link numbers from LLM (no crash)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/valid",
            "https://example.com/also-valid",
          ]),
        },
        "https://example.com/valid": {
          html: makeHtml([]),
        },
        "https://example.com/also-valid": {
          html: makeHtml([]),
        },
      });

      // LLM returns out-of-range numbers (0, 5, 99, -1) and one valid (1)
      mockLLM.invokeStructured.mockResolvedValue({
        relevant: [0, 1, 5, 99, -1],
      });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // Should not crash, and only valid link (index 1) should be followed
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/valid");
      // Link 2 (index 2 = also-valid) was not in the valid list
      expect(urls).not.toContain("https://example.com/also-valid");
    });
  });

  // -------------------------------------------------------------------------
  // Per-link classification
  // -------------------------------------------------------------------------
  describe("per-link classification", () => {
    it("should queue yes links and skip no links", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/relevant",
            "https://example.com/irrelevant",
            "https://example.com/also-relevant",
          ]),
        },
        "https://example.com/relevant": {
          html: makeHtml([]),
        },
        "https://example.com/irrelevant": {
          html: makeHtml([]),
        },
        "https://example.com/also-relevant": {
          html: makeHtml([]),
        },
      });

      // Per-link: each link gets its own call
      // First link: relevant, second: not relevant, third: relevant
      mockLLM.invokeStructured
        .mockResolvedValueOnce({ relevant: true })
        .mockResolvedValueOnce({ relevant: false })
        .mockResolvedValueOnce({ relevant: true });

      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Find relevant pages",
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/relevant");
      expect(urls).toContain("https://example.com/also-relevant");
      expect(urls).not.toContain("https://example.com/irrelevant");
    });

    it("should use 'link-classifier-per-link' as callSite for per-link classification", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/page"]),
        },
        "https://example.com/page": {
          html: makeHtml([]),
        },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: true });

      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      expect(mockLLM.invokeStructured).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ callSite: "link-classifier-per-link" }),
      );
    });

    it("should include description, link URL, and context in per-link prompt", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            {
              href: "https://example.com/docs/api",
              text: "API Reference",
              context: "Complete reference for all REST endpoints",
            },
          ]),
        },
        "https://example.com/docs/api": {
          html: makeHtml([]),
        },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: true });

      const description = "Fetch API documentation";
      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        description,
      );

      await crawler.crawl();

      const prompt = mockLLM.invokeStructured.mock.calls[0][0] as string;
      expect(prompt).toContain(description);
      expect(prompt).toContain("https://example.com/docs/api");
      // Context from surrounding text
      expect(prompt).toContain("REST endpoints");
    });
  });

  // -------------------------------------------------------------------------
  // Classification mode selection
  // -------------------------------------------------------------------------
  describe("classification mode selection", () => {
    it("should use batch classifier when linkClassification is 'batch'", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
          ]),
        },
        "https://example.com/a": { html: makeHtml([]) },
        "https://example.com/b": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1, 2] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      // Batch mode: one call for all links on a page
      expect(mockLLM.invokeStructured).toHaveBeenCalledTimes(1);
      // Should have used link-classifier (batch callSite)
      expect(mockLLM.invokeStructured).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ callSite: "link-classifier" }),
      );
    });

    it("should use per-link classifier when linkClassification is 'per-link'", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
          ]),
        },
        "https://example.com/a": { html: makeHtml([]) },
        "https://example.com/b": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: true });

      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      // Per-link mode: one call PER link
      expect(mockLLM.invokeStructured).toHaveBeenCalledTimes(2);
      // Should have used link-classifier-per-link callSite
      expect(mockLLM.invokeStructured).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ callSite: "link-classifier-per-link" }),
      );
    });

    it("should default to batch mode when linkClassification is not set", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      // No linkClassification set -- should default to 'batch'
      const config = makeConfig({ linkClassification: undefined });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      // Batch mode call site
      expect(mockLLM.invokeStructured).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ callSite: "link-classifier" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // LLM error handling (fail-open)
  // -------------------------------------------------------------------------
  describe("LLM classification error handling", () => {
    it("should fall back to including the link when batch classification errors", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/should-be-included",
          ]),
        },
        "https://example.com/should-be-included": {
          html: makeHtml([]),
        },
      });

      // LLM throws an error
      mockLLM.invokeStructured.mockRejectedValue(new Error("LLM API down"));

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // The link should still be followed (fail-open behavior)
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com/should-be-included");
    });

    it("should fall back to including the link when per-link classification errors", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/included-on-error",
          ]),
        },
        "https://example.com/included-on-error": {
          html: makeHtml([]),
        },
      });

      // LLM throws an error for per-link mode
      mockLLM.invokeStructured.mockRejectedValue(
        new Error("LLM timeout"),
      );

      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // Link should still be followed (fail-open)
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com/included-on-error");
    });

    it("should continue crawling when classification fails for some pages", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
          ]),
        },
        "https://example.com/a": {
          html: makeHtml(["https://example.com/c"]),
        },
        "https://example.com/b": {
          html: makeHtml([]),
        },
        "https://example.com/c": {
          html: makeHtml([]),
        },
      });

      // First classification call (for root links) errors
      mockLLM.invokeStructured
        .mockRejectedValueOnce(new Error("LLM error"))
        // Second classification call (for page A's links) succeeds
        .mockResolvedValueOnce({ relevant: [1] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // All pages should be fetched: root + a + b (from error fallback) + c (from successful classification)
      expect(result.pages.length).toBeGreaterThanOrEqual(3);
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/a");
      expect(urls).toContain("https://example.com/b");
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("should handle LLM returning empty relevant list (no links followed)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
          ]),
        },
        "https://example.com/a": { html: makeHtml([]) },
        "https://example.com/b": { html: makeHtml([]) },
      });

      // LLM returns empty list (no links are relevant)
      mockLLM.invokeStructured.mockResolvedValue({ relevant: [] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Very specific topic",
      );

      const result = await crawler.crawl();

      // Only root page should be fetched
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
    });

    it("should handle LLM returning all links as relevant (behaves like simple mode)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
          ]),
        },
        "https://example.com/a": { html: makeHtml([]) },
        "https://example.com/b": { html: makeHtml([]) },
        "https://example.com/c": { html: makeHtml([]) },
      });

      // LLM returns ALL links as relevant
      mockLLM.invokeStructured.mockResolvedValue({
        relevant: [1, 2, 3],
      });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Everything is relevant",
      );

      const result = await crawler.crawl();

      // All pages should be fetched
      expect(result.pages).toHaveLength(4);
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/a");
      expect(urls).toContain("https://example.com/b");
      expect(urls).toContain("https://example.com/c");
    });

    it("should handle page with 100+ links in batch mode (chunking)", async () => {
      // Create 105 links on the root page
      const linkUrls: string[] = [];
      const responses: Record<string, { html: string } | Error> = {};

      for (let i = 0; i < 105; i++) {
        const url = `https://example.com/page${i}`;
        linkUrls.push(url);
        responses[url] = { html: makeHtml([]) };
      }
      responses["https://example.com"] = { html: makeHtml(linkUrls) };

      const fetcher = createMockFetcher(responses);

      // Mock LLM to approve all links in each chunk
      // With 105 links and chunk size 50, there should be 3 chunks (50 + 50 + 5)
      mockLLM.invokeStructured
        .mockResolvedValueOnce({
          relevant: Array.from({ length: 50 }, (_, i) => i + 1),
        })
        .mockResolvedValueOnce({
          relevant: Array.from({ length: 50 }, (_, i) => i + 1),
        })
        .mockResolvedValueOnce({
          relevant: Array.from({ length: 5 }, (_, i) => i + 1),
        });

      const config = makeConfig({
        linkClassification: "batch",
        maxPages: 110, // Allow all pages
      });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Get everything",
      );

      const result = await crawler.crawl();

      // All 105 links + root = 106 pages
      expect(result.pages).toHaveLength(106);
      // Should have been 3 LLM calls (3 chunks)
      expect(mockLLM.invokeStructured).toHaveBeenCalledTimes(3);
    });

    it("should handle description that is empty string", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "", // Empty description
      );

      const result = await crawler.crawl();

      // Should not crash; prompt should still include the (empty) description
      expect(result.pages.length).toBeGreaterThanOrEqual(1);
      const prompt = mockLLM.invokeStructured.mock.calls[0][0] as string;
      expect(prompt).toContain('Given the goal: ""');
    });

    it("should handle very short description", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "API",
      );

      const result = await crawler.crawl();

      // Should work fine with short description
      expect(result.pages.length).toBeGreaterThanOrEqual(1);
      const prompt = mockLLM.invokeStructured.mock.calls[0][0] as string;
      expect(prompt).toContain("API");
    });

    it("should handle page with no links (no LLM call needed)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: "<html><body><h1>No links here</h1></body></html>",
        },
      });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      // No LLM call should be made since there are no links to classify
      expect(mockLLM.invokeStructured).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // BFS behavior (inherited pattern)
  // -------------------------------------------------------------------------
  describe("BFS crawl behavior", () => {
    it("should crawl root URL and follow LLM-approved same-domain links", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/about",
            "https://example.com/docs",
          ]),
        },
        "https://example.com/about": { html: makeHtml([]) },
        "https://example.com/docs": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({
        relevant: [1, 2],
      });

      const config = makeConfig();
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Everything",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(3);
      expect(result.pages.map((p) => p.url)).toEqual(
        expect.arrayContaining([
          "https://example.com",
          "https://example.com/about",
          "https://example.com/docs",
        ]),
      );
    });

    it("should respect maxDepth limit", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/depth1"]),
        },
        "https://example.com/depth1": {
          html: makeHtml(["https://example.com/depth2"]),
        },
        "https://example.com/depth2": {
          html: makeHtml([]),
        },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig({ maxDepth: 1 });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/depth1");
      expect(urls).not.toContain("https://example.com/depth2");
    });

    it("should respect maxPages limit", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
          ]),
        },
        "https://example.com/a": { html: makeHtml([]) },
        "https://example.com/b": { html: makeHtml([]) },
        "https://example.com/c": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({
        relevant: [1, 2, 3],
      });

      const config = makeConfig({ maxPages: 2 });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2);
    });

    it("should skip already-visited URLs", async () => {
      // Circular: root -> A -> root
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": {
          html: makeHtml(["https://example.com"]),
        },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig();
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // Each URL only fetched once
      expect(result.pages).toHaveLength(2);
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    });

    it("should convert each page and write output", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig();
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      expect(mockConverter.convert).toHaveBeenCalledTimes(2);
      expect(mockOutputWriter.writePage).toHaveBeenCalledTimes(2);
    });

    it("should fire onPageFetched callback", async () => {
      const onPageFetched = vi.fn();
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({ onPageFetched });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      expect(onPageFetched).toHaveBeenCalledTimes(1);
      expect(onPageFetched.mock.calls[0][0].url).toBe("https://example.com");
    });

    it("should handle fetch errors gracefully and continue crawling", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/fail",
            "https://example.com/ok",
          ]),
        },
        "https://example.com/fail": new Error("Server error"),
        "https://example.com/ok": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({
        relevant: [1, 2],
      });

      const config = makeConfig();
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2); // root + ok
      expect(result.skipped).toHaveLength(1); // fail
      expect(result.skipped[0].url).toBe("https://example.com/fail");
    });

    it("should return correct FetchResult with stats", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig({ outputDir: "/my/output" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2);
      expect(result.outputPath).toBe("/my/output");
      expect(result.stats.totalPages).toBe(2);
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Integration-style: full smart crawl with multiple levels
  // -------------------------------------------------------------------------
  describe("integration: full smart crawl with mocked dependencies", () => {
    it("should perform multi-level smart crawl following only relevant links", async () => {
      // Build a site structure:
      //   root -> /docs, /blog, /about
      //   /docs -> /docs/api, /docs/guide
      //   /blog -> /blog/post1
      // LLM approves only docs-related links
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/docs",
            "https://example.com/blog",
            "https://example.com/about",
          ]),
        },
        "https://example.com/docs": {
          html: makeHtml([
            "https://example.com/docs/api",
            "https://example.com/docs/guide",
          ]),
        },
        "https://example.com/blog": {
          html: makeHtml(["https://example.com/blog/post1"]),
        },
        "https://example.com/about": {
          html: makeHtml([]),
        },
        "https://example.com/docs/api": {
          html: makeHtml([]),
        },
        "https://example.com/docs/guide": {
          html: makeHtml([]),
        },
        "https://example.com/blog/post1": {
          html: makeHtml([]),
        },
      });

      // Root page classification: approve only /docs (link 1 of 3)
      mockLLM.invokeStructured
        .mockResolvedValueOnce({ relevant: [1] }) // root: only /docs
        .mockResolvedValueOnce({ relevant: [1, 2] }); // /docs: both sub-links

      const config = makeConfig({
        linkClassification: "batch",
      });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Fetch all documentation",
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      // Should have: root, /docs, /docs/api, /docs/guide
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/docs");
      expect(urls).toContain("https://example.com/docs/api");
      expect(urls).toContain("https://example.com/docs/guide");
      // Should NOT have: /blog, /about, /blog/post1
      expect(urls).not.toContain("https://example.com/blog");
      expect(urls).not.toContain("https://example.com/about");
      expect(urls).not.toContain("https://example.com/blog/post1");
    });

    it("should verify only relevant links are followed in per-link mode", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/api",
            "https://example.com/marketing",
            "https://example.com/changelog",
          ]),
        },
        "https://example.com/api": { html: makeHtml([]) },
        "https://example.com/marketing": { html: makeHtml([]) },
        "https://example.com/changelog": { html: makeHtml([]) },
      });

      // Per-link: api=yes, marketing=no, changelog=yes
      mockLLM.invokeStructured
        .mockResolvedValueOnce({ relevant: true }) // api
        .mockResolvedValueOnce({ relevant: false }) // marketing
        .mockResolvedValueOnce({ relevant: true }); // changelog

      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Fetch technical docs",
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/api");
      expect(urls).toContain("https://example.com/changelog");
      expect(urls).not.toContain("https://example.com/marketing");
    });
  });

  // -------------------------------------------------------------------------
  // Zod schema validation
  // -------------------------------------------------------------------------
  describe("schema validation", () => {
    it("should pass batch classification schema with relevant number array", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: [1] });

      const config = makeConfig({ linkClassification: "batch" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      // Verify the schema passed to invokeStructured can parse batch results
      const schema = mockLLM.invokeStructured.mock.calls[0][1];
      expect(schema.parse({ relevant: [1, 2, 3] })).toEqual({
        relevant: [1, 2, 3],
      });
      expect(schema.parse({ relevant: [] })).toEqual({ relevant: [] });
    });

    it("should pass per-link classification schema with relevant boolean", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": { html: makeHtml([]) },
      });

      mockLLM.invokeStructured.mockResolvedValue({ relevant: true });

      const config = makeConfig({ linkClassification: "per-link" });
      const crawler = new SmartCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      // Verify the schema passed to invokeStructured can parse per-link results
      const schema = mockLLM.invokeStructured.mock.calls[0][1];
      expect(schema.parse({ relevant: true })).toEqual({ relevant: true });
      expect(schema.parse({ relevant: false })).toEqual({ relevant: false });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SimpleCrawler } from "../crawler/simple.js";
import type { Fetcher } from "../fetcher/index.js";
import type { Converter } from "../converter/index.js";
import type { OutputWriter } from "../output/index.js";
import type { WebsiteFetchConfig, FetchedPage, FetchedPageRaw } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WebsiteFetchConfig for testing. */
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
    delay: 0,
    concurrency: 3,
    respectRobots: false,
    adaptiveRateLimit: false,
    ...overrides,
  };
}

/** Create a mock FetchedPageRaw result for a given URL. */
function makeFetchedPageRaw(
  url: string,
  html: string,
): FetchedPageRaw {
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
 * Links are specified as absolute URLs.
 */
function makeHtml(links: string[]): string {
  const anchors = links
    .map((href) => `<a href="${href}">Link to ${href}</a>`)
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
    convert: vi.fn(async (html: string, url: string) => {
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

// ---------------------------------------------------------------------------
// SimpleCrawler Tests
// ---------------------------------------------------------------------------
describe("SimpleCrawler", () => {
  let mockConverter: Converter;
  let mockOutputWriter: OutputWriter;

  beforeEach(() => {
    mockConverter = createMockConverter();
    mockOutputWriter = createMockOutputWriter();
  });

  // -------------------------------------------------------------------------
  // Basic crawling
  // -------------------------------------------------------------------------
  describe("basic crawling", () => {
    it("should crawl root URL and follow same-domain links", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/about",
            "https://example.com/docs",
          ]),
        },
        "https://example.com/about": {
          html: makeHtml([]),
        },
        "https://example.com/docs": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
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

    it("should convert each page and write output", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/about"]),
        },
        "https://example.com/about": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      await crawler.crawl();

      // Converter should have been called for each page
      expect(mockConverter.convert).toHaveBeenCalledTimes(2);
      // Output writer should have been called for each page
      expect(mockOutputWriter.writePage).toHaveBeenCalledTimes(2);
    });

    it("should set correct depth for each page in BFS order", async () => {
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

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(3);
      const depthMap = new Map(result.pages.map((p) => [p.url, p.depth]));
      expect(depthMap.get("https://example.com")).toBe(0);
      expect(depthMap.get("https://example.com/depth1")).toBe(1);
      expect(depthMap.get("https://example.com/depth2")).toBe(2);
    });

    it("should process pages in BFS order (breadth-first)", async () => {
      // Root links to A and B. A links to C. We should see root, A, B, C.
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

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      expect(urls).toHaveLength(4);
      // Root first, then depth-1 pages (a, b), then depth-2 page (c)
      expect(urls[0]).toBe("https://example.com");
      // A and B should come before C
      expect(urls.indexOf("https://example.com/c")).toBeGreaterThan(
        urls.indexOf("https://example.com/a"),
      );
      expect(urls.indexOf("https://example.com/c")).toBeGreaterThan(
        urls.indexOf("https://example.com/b"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // maxDepth limit
  // -------------------------------------------------------------------------
  describe("maxDepth limit", () => {
    it("should respect maxDepth limit and not crawl beyond depth N", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/depth1"]),
        },
        "https://example.com/depth1": {
          html: makeHtml(["https://example.com/depth2"]),
        },
        "https://example.com/depth2": {
          html: makeHtml(["https://example.com/depth3"]),
        },
        "https://example.com/depth3": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        maxDepth: 1,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // depth 0 = root, depth 1 = depth1. depth 2 should be skipped
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/depth1");
      expect(urls).not.toContain("https://example.com/depth2");
      expect(urls).not.toContain("https://example.com/depth3");
    });

    it("should record pages beyond maxDepth as skipped", async () => {
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

      const config = makeConfig({
        url: "https://example.com",
        maxDepth: 1,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // depth2 should be in skipped with max depth reason
      const skippedUrls = result.skipped.map((s) => s.url);
      expect(skippedUrls).toContain("https://example.com/depth2");
      const skippedEntry = result.skipped.find(
        (s) => s.url === "https://example.com/depth2",
      );
      expect(skippedEntry?.reason).toMatch(/max depth/i);
    });

    it("should allow maxDepth of 0 to only fetch root", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        maxDepth: 0,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
    });
  });

  // -------------------------------------------------------------------------
  // maxPages limit
  // -------------------------------------------------------------------------
  describe("maxPages limit", () => {
    it("should respect maxPages limit and stop after N pages", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/page1",
            "https://example.com/page2",
            "https://example.com/page3",
          ]),
        },
        "https://example.com/page1": {
          html: makeHtml([]),
        },
        "https://example.com/page2": {
          html: makeHtml([]),
        },
        "https://example.com/page3": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        maxPages: 2,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2);
    });

    it("should fetch only root when maxPages = 1", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/a",
            "https://example.com/b",
          ]),
        },
        "https://example.com/a": {
          html: makeHtml([]),
        },
        "https://example.com/b": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        maxPages: 1,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
    });

    it("should not extract links when maxPages is already reached", async () => {
      // When maxPages=1, after fetching root, links should NOT be extracted
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/never-reached"]),
        },
        "https://example.com/never-reached": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        maxPages: 1,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      // The fetcher should only have been called once (for root)
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Visited URL tracking (no cycles)
  // -------------------------------------------------------------------------
  describe("visited URL tracking", () => {
    it("should skip already-visited URLs and avoid infinite loops", async () => {
      // Circular: A -> B -> A
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/b"]),
        },
        "https://example.com/b": {
          html: makeHtml(["https://example.com"]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // Each URL should only be fetched once
      expect(result.pages).toHaveLength(2);
      expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    });

    it("should handle circular links A -> B -> C -> A without infinite loop", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/b"]),
        },
        "https://example.com/b": {
          html: makeHtml(["https://example.com/c"]),
        },
        "https://example.com/c": {
          html: makeHtml(["https://example.com"]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(3);
      expect(fetcher.fetch).toHaveBeenCalledTimes(3);
    });

    it("should treat normalized URLs as the same (trailing slash)", async () => {
      // Root links to /about/ and /about (same URL after normalization)
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/about",
            "https://example.com/about/",
          ]),
        },
        "https://example.com/about": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // /about and /about/ are the same, should only be fetched once
      expect(result.pages).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Include/exclude patterns
  // -------------------------------------------------------------------------
  describe("include/exclude patterns", () => {
    it("should apply includePatterns and only follow matching links", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/docs/intro",
            "https://example.com/blog/post1",
          ]),
        },
        "https://example.com/docs/intro": {
          html: makeHtml([]),
        },
        "https://example.com/blog/post1": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        includePatterns: ["/docs/**"],
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      // Root is always fetched, plus /docs/intro which matches /docs/**
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/docs/intro");
      // /blog/post1 should NOT be fetched (doesn't match /docs/**)
      expect(urls).not.toContain("https://example.com/blog/post1");
    });

    it("should apply excludePatterns and skip matching links", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/docs/intro",
            "https://example.com/admin/dashboard",
          ]),
        },
        "https://example.com/docs/intro": {
          html: makeHtml([]),
        },
        "https://example.com/admin/dashboard": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        excludePatterns: ["/admin/**"],
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/docs/intro");
      // /admin/dashboard should NOT be fetched (excluded)
      expect(urls).not.toContain("https://example.com/admin/dashboard");
    });
  });

  // -------------------------------------------------------------------------
  // Event callbacks
  // -------------------------------------------------------------------------
  describe("event callbacks", () => {
    it("should call onPageFetched for each successfully fetched page", async () => {
      const onPageFetched = vi.fn();
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({
        url: "https://example.com",
        onPageFetched,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      await crawler.crawl();

      expect(onPageFetched).toHaveBeenCalledTimes(2);
      // Check that onPageFetched receives a FetchedPage object
      const firstCall = onPageFetched.mock.calls[0][0] as FetchedPage;
      expect(firstCall.url).toBe("https://example.com");
      expect(firstCall.markdown).toBeDefined();
      expect(firstCall.depth).toBe(0);

      const secondCall = onPageFetched.mock.calls[1][0] as FetchedPage;
      expect(secondCall.url).toBe("https://example.com/a");
      expect(secondCall.depth).toBe(1);
    });

    it("should call onError when a page fetch fails", async () => {
      const onError = vi.fn();
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/broken"]),
        },
        "https://example.com/broken": new Error("Server error"),
      });

      const config = makeConfig({
        url: "https://example.com",
        onError,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      await crawler.crawl();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        "https://example.com/broken",
        expect.any(Error),
      );
    });

    it("should call onPageSkipped when a page exceeds maxDepth", async () => {
      const onPageSkipped = vi.fn();
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

      const config = makeConfig({
        url: "https://example.com",
        maxDepth: 1,
        onPageSkipped,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      await crawler.crawl();

      // depth2 exceeds maxDepth=1, should be skipped
      expect(onPageSkipped).toHaveBeenCalledWith(
        "https://example.com/depth2",
        expect.stringMatching(/max depth/i),
      );
    });

    it("should call onPageSkipped when a page fetch fails", async () => {
      const onPageSkipped = vi.fn();
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/error"]),
        },
        "https://example.com/error": new Error("Network failure"),
      });

      const config = makeConfig({
        url: "https://example.com",
        onPageSkipped,
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      await crawler.crawl();

      // The errored page should be recorded as skipped
      expect(onPageSkipped).toHaveBeenCalledWith(
        "https://example.com/error",
        expect.stringContaining("Network failure"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // FetchResult stats
  // -------------------------------------------------------------------------
  describe("FetchResult stats", () => {
    it("should return correct FetchResult with pages, skipped, and stats", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a", "https://example.com/b"]),
        },
        "https://example.com/a": {
          html: makeHtml([]),
        },
        "https://example.com/b": new Error("Failed"),
      });

      const config = makeConfig({
        url: "https://example.com",
        outputDir: "/my/output",
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2); // root + /a
      expect(result.skipped).toHaveLength(1); // /b failed
      expect(result.outputPath).toBe("/my/output");
      expect(result.stats.totalPages).toBe(2);
      expect(result.stats.totalSkipped).toBe(1);
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("should continue crawling when individual page fetch fails", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://example.com/fail",
            "https://example.com/ok",
          ]),
        },
        "https://example.com/fail": new Error("Server error"),
        "https://example.com/ok": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // Should have fetched root and /ok successfully
      expect(result.pages).toHaveLength(2);
      expect(result.pages.map((p) => p.url)).toContain(
        "https://example.com/ok",
      );
      // /fail should be in skipped
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].url).toBe("https://example.com/fail");
    });

    it("should record the error message in skipped when fetch fails", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/broken"]),
        },
        "https://example.com/broken": new Error("ECONNREFUSED"),
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      const skippedPage = result.skipped.find(
        (s) => s.url === "https://example.com/broken",
      );
      expect(skippedPage).toBeDefined();
      expect(skippedPage?.reason).toContain("ECONNREFUSED");
    });

    it("should handle fetch error on root URL gracefully", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": new Error("Root page unavailable"),
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // Should return empty pages, with root in skipped
      expect(result.pages).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].url).toBe("https://example.com");
      expect(result.skipped[0].reason).toContain("Root page unavailable");
    });

    it("should handle non-Error throws gracefully", async () => {
      const fetcher: Fetcher = {
        fetch: vi.fn(async () => {
          throw "string error";
        }),
        isAllowed: vi.fn(async () => true),
        getCrawlDelay: vi.fn(() => undefined),
        close: vi.fn(),
      };

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // Should still record it as skipped (not crash)
      expect(result.pages).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("should handle root URL with no links (single-page crawl)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: "<html><body><h1>No links here</h1></body></html>",
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
      expect(result.skipped).toHaveLength(0);
    });

    it("should handle all links being cross-domain (only root page fetched)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml([
            "https://other.com/page1",
            "https://different.com/page2",
          ]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      // Only root should be fetched since extractLinks uses sameDomainOnly
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
    });

    it("should handle pages that include markdown field from converter", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: "<html><body><h1>Hello</h1></body></html>",
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages[0].markdown).toBe(
        "# Converted: https://example.com",
      );
    });

    it("should write pages to output immediately as they are fetched", async () => {
      const writeOrder: string[] = [];
      const outputWriter: OutputWriter = {
        writePage: vi.fn(async (page: FetchedPage) => {
          writeOrder.push(page.url);
          return "output/path.md";
        }),
        urlToFilePath: vi.fn(() => "output/path.md"),
      };

      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/a"]),
        },
        "https://example.com/a": {
          html: makeHtml([]),
        },
      });

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        outputWriter,
      );

      await crawler.crawl();

      // Pages should be written in BFS order
      expect(writeOrder).toEqual([
        "https://example.com",
        "https://example.com/a",
      ]);
    });

    it("should handle large number of links without issues", async () => {
      // Create a root page with many links
      const linkUrls: string[] = [];
      const responses: Record<string, { html: string } | Error> = {};

      for (let i = 0; i < 50; i++) {
        const url = `https://example.com/page${i}`;
        linkUrls.push(url);
        responses[url] = { html: makeHtml([]) };
      }
      responses["https://example.com"] = { html: makeHtml(linkUrls) };

      const fetcher = createMockFetcher(responses);

      const config = makeConfig({
        url: "https://example.com",
        maxPages: 10, // Limit to 10
      });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(10);
    });
  });

  // -------------------------------------------------------------------------
  // Streaming output verification
  // -------------------------------------------------------------------------
  describe("streaming output", () => {
    it("should call outputWriter.writePage before extracting links", async () => {
      const callOrder: string[] = [];

      const outputWriter: OutputWriter = {
        writePage: vi.fn(async (page: FetchedPage) => {
          callOrder.push(`write:${page.url}`);
          return "output/path.md";
        }),
        urlToFilePath: vi.fn(() => "output/path.md"),
      };

      const fetcherFn = vi.fn(async (url: string): Promise<FetchedPageRaw> => {
        callOrder.push(`fetch:${url}`);
        if (url === "https://example.com") {
          return makeFetchedPageRaw(
            url,
            makeHtml(["https://example.com/child"]),
          );
        }
        return makeFetchedPageRaw(url, makeHtml([]));
      });

      const fetcher: Fetcher = {
        fetch: fetcherFn,
        isAllowed: vi.fn(async () => true),
        getCrawlDelay: vi.fn(() => undefined),
        close: vi.fn(),
      };

      const config = makeConfig({ url: "https://example.com" });
      const crawler = new SimpleCrawler(
        config,
        fetcher,
        mockConverter,
        outputWriter,
      );

      await crawler.crawl();

      // Root should be written before child is fetched
      const writeRootIndex = callOrder.indexOf("write:https://example.com");
      const fetchChildIndex = callOrder.indexOf(
        "fetch:https://example.com/child",
      );
      expect(writeRootIndex).toBeLessThan(fetchChildIndex);
    });
  });
});

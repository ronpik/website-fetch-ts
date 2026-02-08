import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFetcher,
  FetchError,
  DEFAULT_USER_AGENT,
} from "../fetcher/index.js";
import type { WebsiteFetchConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal WebsiteFetchConfig for testing. */
function makeConfig(overrides: Partial<WebsiteFetchConfig> = {}): WebsiteFetchConfig {
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

/** Create a mock Response object. */
function mockResponse(options: {
  status?: number;
  ok?: boolean;
  headers?: Record<string, string>;
  body?: string;
  url?: string;
}): Response {
  const {
    status = 200,
    ok = true,
    headers = { "content-type": "text/html; charset=utf-8" },
    body = "<html><body>Hello</body></html>",
  } = options;

  const headersObj = new Headers(headers);

  return {
    ok,
    status,
    headers: headersObj,
    text: async () => body,
    json: async () => JSON.parse(body),
    url: options.url ?? "",
  } as unknown as Response;
}

/** Create a robots.txt mock response (allow all). */
function mockRobotsAllowAll(): Response {
  return mockResponse({
    body: "User-agent: *\nAllow: /\n",
    headers: { "content-type": "text/plain" },
  });
}

/** Create a robots.txt mock response that disallows a path. */
function mockRobotsDisallow(path: string): Response {
  return mockResponse({
    body: `User-agent: *\nDisallow: ${path}\n`,
    headers: { "content-type": "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// Temp directory for cookie file tests
// ---------------------------------------------------------------------------
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "fetcher-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. FetchError class
// ---------------------------------------------------------------------------
describe("FetchError", () => {
  it("should have name, message, url, and optional statusCode", () => {
    const error = new FetchError("Something went wrong", "https://example.com/page", 500);
    expect(error.name).toBe("FetchError");
    expect(error.message).toBe("Something went wrong");
    expect(error.url).toBe("https://example.com/page");
    expect(error.statusCode).toBe(500);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FetchError);
  });

  it("should have undefined statusCode when not provided", () => {
    const error = new FetchError("Network error", "https://example.com");
    expect(error.statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. DEFAULT_USER_AGENT
// ---------------------------------------------------------------------------
describe("DEFAULT_USER_AGENT", () => {
  it("should be website-fetch/1.0", () => {
    expect(DEFAULT_USER_AGENT).toBe("website-fetch/1.0");
  });
});

// ---------------------------------------------------------------------------
// 3. createFetcher - basic fetch
// ---------------------------------------------------------------------------
describe("createFetcher", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("fetch() - successful 200 HTML response", () => {
    it("should return FetchedPageRaw with correct fields", async () => {
      const htmlBody = "<html><head><title>Test</title></head><body>Hello World</body></html>";
      const mockFetch = vi.fn()
        // First call: robots.txt
        .mockResolvedValueOnce(mockRobotsAllowAll())
        // Second call: actual page
        .mockResolvedValueOnce(
          mockResponse({
            status: 200,
            body: htmlBody,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-custom": "value",
            },
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/page");

      expect(result.url).toBe("https://example.com/page");
      expect(result.html).toBe(htmlBody);
      expect(result.statusCode).toBe(200);
      expect(result.headers).toBeDefined();
      expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(result.fetchedAt).toBeInstanceOf(Date);
    });
  });

  describe("fetch() - robots.txt blocking", () => {
    it("should throw FetchError when URL is disallowed by robots.txt", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsDisallow("/private/"));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig({ respectRobots: true }));

      try {
        await fetcher.fetch("https://example.com/private/secret");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).message).toMatch(/disallowed by robots\.txt/);
        expect((e as FetchError).url).toBe("https://example.com/private/secret");
      }
    });

    it("should NOT check robots.txt when respectRobots is false", async () => {
      const htmlBody = "<html><body>Private page</body></html>";
      const mockFetch = vi.fn()
        // Only the page fetch, no robots.txt fetch
        .mockResolvedValueOnce(
          mockResponse({ body: htmlBody }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig({ respectRobots: false }));
      const result = await fetcher.fetch("https://example.com/private/secret");

      expect(result.html).toBe(htmlBody);
      // Should NOT have called fetch for robots.txt
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // The single call should be for the page, not robots.txt
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://example.com/private/secret",
      );
    });
  });

  describe("fetch() - robots.txt caching", () => {
    it("should only fetch robots.txt once per domain", async () => {
      const mockFetch = vi.fn()
        // robots.txt fetch (once)
        .mockResolvedValueOnce(mockRobotsAllowAll())
        // page 1
        .mockResolvedValueOnce(mockResponse({ body: "<html>Page 1</html>" }))
        // page 2 (no robots.txt fetch needed)
        .mockResolvedValueOnce(mockResponse({ body: "<html>Page 2</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      await fetcher.fetch("https://example.com/page1");
      await fetcher.fetch("https://example.com/page2");

      // 1 robots.txt + 2 page fetches = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3);
      // First call should be robots.txt
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://example.com/robots.txt",
      );
    });
  });

  describe("fetch() - robots.txt failure treated as allow-all", () => {
    it("should allow fetch when robots.txt returns 404", async () => {
      const mockFetch = vi.fn()
        // robots.txt 404
        .mockResolvedValueOnce(
          mockResponse({ status: 404, ok: false, headers: { "content-type": "text/plain" } }),
        )
        // actual page
        .mockResolvedValueOnce(
          mockResponse({ body: "<html>Content</html>" }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/page");

      expect(result.html).toBe("<html>Content</html>");
    });

    it("should allow fetch when robots.txt fetch throws network error", async () => {
      const mockFetch = vi.fn()
        // robots.txt network error
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        // actual page
        .mockResolvedValueOnce(
          mockResponse({ body: "<html>Content</html>" }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/page");

      expect(result.html).toBe("<html>Content</html>");
    });
  });

  describe("fetch() - custom headers", () => {
    it("should include custom headers in requests", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(
        makeConfig({
          headers: {
            Authorization: "Bearer token123",
            "X-Custom-Header": "custom-value",
          },
        }),
      );
      await fetcher.fetch("https://example.com/page");

      // The page fetch (second call) should include custom headers
      const pageFetchCall = mockFetch.mock.calls[1];
      const requestHeaders = pageFetchCall[1].headers;
      expect(requestHeaders["Authorization"]).toBe("Bearer token123");
      expect(requestHeaders["X-Custom-Header"]).toBe("custom-value");
    });

    it("should use custom User-Agent from headers", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(
        makeConfig({
          headers: { "User-Agent": "my-custom-bot/2.0" },
        }),
      );
      await fetcher.fetch("https://example.com/page");

      const pageFetchCall = mockFetch.mock.calls[1];
      expect(pageFetchCall[1].headers["User-Agent"]).toBe("my-custom-bot/2.0");
    });
  });

  describe("fetch() - cookie file support", () => {
    it("should load cookies and send matching ones with requests", async () => {
      const cookieFilePath = join(tempDir, "cookies.txt");
      await writeFile(
        cookieFilePath,
        ".example.com\tTRUE\t/\tFALSE\t0\tsession_id\tabc123\n",
      );

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(
        makeConfig({ cookieFile: cookieFilePath }),
      );
      await fetcher.fetch("https://example.com/page");

      const pageFetchCall = mockFetch.mock.calls[1];
      expect(pageFetchCall[1].headers["Cookie"]).toBe("session_id=abc123");
    });

    it("should not send cookies for non-matching domains", async () => {
      const cookieFilePath = join(tempDir, "cookies.txt");
      await writeFile(
        cookieFilePath,
        ".example.com\tTRUE\t/\tFALSE\t0\tsession_id\tabc123\n",
      );

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(
        makeConfig({ cookieFile: cookieFilePath }),
      );
      await fetcher.fetch("https://other.com/page");

      const pageFetchCall = mockFetch.mock.calls[1];
      // Cookie header should not be set (or undefined)
      expect(pageFetchCall[1].headers["Cookie"]).toBeUndefined();
    });
  });

  describe("fetch() - redirect handling", () => {
    it("should follow redirects and record the final URL", async () => {
      const mockFetch = vi.fn()
        // robots.txt
        .mockResolvedValueOnce(mockRobotsAllowAll())
        // First request: 301 redirect
        .mockResolvedValueOnce({
          ok: false,
          status: 301,
          headers: new Headers({ location: "https://example.com/new-page" }),
        } as unknown as Response)
        // Second request (redirected): 200
        .mockResolvedValueOnce(
          mockResponse({
            body: "<html>Final page</html>",
            headers: { "content-type": "text/html" },
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/old-page");

      expect(result.url).toBe("https://example.com/new-page");
      expect(result.html).toBe("<html>Final page</html>");
    });

    it("should follow multiple redirects", async () => {
      const mockFetch = vi.fn()
        // robots.txt
        .mockResolvedValueOnce(mockRobotsAllowAll())
        // 1st redirect
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://example.com/step2" }),
        } as unknown as Response)
        // 2nd redirect
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://example.com/step3" }),
        } as unknown as Response)
        // Final response
        .mockResolvedValueOnce(
          mockResponse({
            body: "<html>Final</html>",
            headers: { "content-type": "text/html" },
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/step1");

      expect(result.url).toBe("https://example.com/step3");
      expect(result.html).toBe("<html>Final</html>");
    });

    it("should throw FetchError when too many redirects", async () => {
      const mockFetch = vi.fn()
        // robots.txt
        .mockResolvedValueOnce(mockRobotsAllowAll());

      // 6 redirects (exceeds MAX_REDIRECTS of 5)
      for (let i = 0; i <= 5; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({
            location: `https://example.com/redirect-${i + 1}`,
          }),
        } as unknown as Response);
      }

      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());

      try {
        await fetcher.fetch("https://example.com/redirect-0");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).message).toMatch(/Too many redirects/);
      }
    });

    it("should resolve relative redirect URLs", async () => {
      const mockFetch = vi.fn()
        // robots.txt
        .mockResolvedValueOnce(mockRobotsAllowAll())
        // Redirect with relative location
        .mockResolvedValueOnce({
          ok: false,
          status: 301,
          headers: new Headers({ location: "/new-path" }),
        } as unknown as Response)
        // Final response
        .mockResolvedValueOnce(
          mockResponse({
            body: "<html>Redirected</html>",
            headers: { "content-type": "text/html" },
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/old-path");

      expect(result.url).toBe("https://example.com/new-path");
    });

    it("should throw FetchError when redirect is missing Location header", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce({
          ok: false,
          status: 301,
          headers: new Headers(), // no location header
        } as unknown as Response);
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());

      try {
        await fetcher.fetch("https://example.com/broken-redirect");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).message).toMatch(/Location header/);
      }
    });
  });

  describe("fetch() - non-HTML content type", () => {
    it("should throw FetchError for non-HTML content type", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(
          mockResponse({
            headers: { "content-type": "application/pdf" },
            body: "binary content",
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());

      try {
        await fetcher.fetch("https://example.com/file.pdf");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).message).toMatch(/Non-HTML content type/);
      }
    });

    it("should accept text/html content type", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(
          mockResponse({
            headers: { "content-type": "text/html" },
            body: "<html>OK</html>",
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/page");
      expect(result.html).toBe("<html>OK</html>");
    });

    it("should accept application/xhtml+xml content type", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(
          mockResponse({
            headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
            body: "<html>XHTML</html>",
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/xhtml-page");
      expect(result.html).toBe("<html>XHTML</html>");
    });

    it("should accept text/html with charset parameter", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(
          mockResponse({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: "<html>OK</html>",
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const result = await fetcher.fetch("https://example.com/page");
      expect(result.html).toBe("<html>OK</html>");
    });
  });

  describe("fetch() - HTTP error status codes", () => {
    it("should throw FetchError for 404 response", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(
          mockResponse({
            status: 404,
            ok: false,
            headers: { "content-type": "text/html" },
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());

      try {
        await fetcher.fetch("https://example.com/not-found");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).statusCode).toBe(404);
        expect((e as FetchError).message).toMatch(/HTTP 404/);
      }
    });

    it("should throw FetchError for 500 response", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        // Use mockResolvedValue (not Once) so all retry attempts get a 500 response
        .mockResolvedValue(
          mockResponse({
            status: 500,
            ok: false,
            headers: { "content-type": "text/html" },
          }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig({ delay: 0 }));

      await expect(
        fetcher.fetch("https://example.com/error"),
      ).rejects.toThrow(FetchError);
    });
  });

  describe("fetch() - network errors", () => {
    it("should throw FetchError on network error", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());

      try {
        await fetcher.fetch("https://example.com/page");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).message).toMatch(/Network error/);
        expect((e as FetchError).message).toContain("ECONNREFUSED");
      }
    });

    it("should throw FetchError with timeout message on AbortError", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockRejectedValueOnce(
          new DOMException("The operation was aborted.", "AbortError"),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());

      try {
        await fetcher.fetch("https://example.com/slow-page");
        expect.unreachable("Should have thrown FetchError");
      } catch (e) {
        expect(e).toBeInstanceOf(FetchError);
        expect((e as FetchError).message).toMatch(/timed out/);
      }
    });
  });

  describe("isAllowed()", () => {
    it("should return true for allowed URLs", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(mockRobotsAllowAll());
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const allowed = await fetcher.isAllowed("https://example.com/public");

      expect(allowed).toBe(true);
    });

    it("should return false for disallowed URLs", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockRobotsDisallow("/private/"),
      );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      const allowed = await fetcher.isAllowed(
        "https://example.com/private/page",
      );

      expect(allowed).toBe(false);
    });

    it("should always return true when respectRobots is false", async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig({ respectRobots: false }));
      const allowed = await fetcher.isAllowed(
        "https://example.com/private/page",
      );

      expect(allowed).toBe(true);
      // Should NOT have fetched robots.txt at all
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getCrawlDelay()", () => {
    it("should return crawl delay after robots.txt is fetched", async () => {
      const robotsTxt = "User-agent: *\nCrawl-delay: 3\nDisallow:\n";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            body: robotsTxt,
            headers: { "content-type": "text/plain" },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({ body: "<html>OK</html>" }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      // First, fetch a page to trigger robots.txt loading
      await fetcher.fetch("https://example.com/page");

      const delay = fetcher.getCrawlDelay("https://example.com/page");
      expect(delay).toBe(3);
    });

    it("should return undefined when robots.txt has not been fetched yet", () => {
      const fetcher = createFetcher(makeConfig());
      const delay = fetcher.getCrawlDelay("https://example.com/page");
      expect(delay).toBeUndefined();
    });

    it("should return undefined when robots.txt has no Crawl-delay", async () => {
      const robotsTxt = "User-agent: *\nDisallow: /admin/\n";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            body: robotsTxt,
            headers: { "content-type": "text/plain" },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({ body: "<html>OK</html>" }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      await fetcher.fetch("https://example.com/page");

      const delay = fetcher.getCrawlDelay("https://example.com/page");
      expect(delay).toBeUndefined();
    });
  });

  describe("close()", () => {
    it("should not throw when called", () => {
      const fetcher = createFetcher(makeConfig());
      expect(() => fetcher.close()).not.toThrow();
    });

    it("should clear robots.txt cache so getCrawlDelay returns undefined", async () => {
      // Use a small crawl-delay to avoid exceeding test timeout
      // (rate limiter sleeps for crawl-delay * 1000 ms before each request)
      const robotsTxt = "User-agent: *\nCrawl-delay: 1\nDisallow:\n";
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            body: robotsTxt,
            headers: { "content-type": "text/plain" },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({ body: "<html>OK</html>" }),
        );
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig({ delay: 0 }));
      await fetcher.fetch("https://example.com/page");

      // Before close, crawl delay should be available
      expect(fetcher.getCrawlDelay("https://example.com/page")).toBe(1);

      fetcher.close();

      // After close, cache should be cleared
      expect(fetcher.getCrawlDelay("https://example.com/page")).toBeUndefined();
    });
  });

  describe("fetch() - uses redirect: manual", () => {
    it("should pass redirect: manual to fetch calls", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      await fetcher.fetch("https://example.com/page");

      // The page fetch (second call) should use redirect: manual
      const pageFetchOptions = mockFetch.mock.calls[1][1];
      expect(pageFetchOptions.redirect).toBe("manual");
    });
  });

  describe("fetch() - sets User-Agent header", () => {
    it("should use DEFAULT_USER_AGENT when no custom User-Agent is provided", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      await fetcher.fetch("https://example.com/page");

      const pageFetchOptions = mockFetch.mock.calls[1][1];
      expect(pageFetchOptions.headers["User-Agent"]).toBe("website-fetch/1.0");
    });
  });

  describe("fetch() - AbortController signal", () => {
    it("should pass an AbortSignal to fetch calls", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockRobotsAllowAll())
        .mockResolvedValueOnce(mockResponse({ body: "<html>OK</html>" }));
      globalThis.fetch = mockFetch;

      const fetcher = createFetcher(makeConfig());
      await fetcher.fetch("https://example.com/page");

      const pageFetchOptions = mockFetch.mock.calls[1][1];
      expect(pageFetchOptions.signal).toBeDefined();
      expect(pageFetchOptions.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

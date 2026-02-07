import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getOrigin,
  fetchRobotsTxt,
  isUrlAllowed,
  getCrawlDelay,
  type RobotsCache,
} from "../fetcher/robots.js";

// ---------------------------------------------------------------------------
// 1. getOrigin - pure utility
// ---------------------------------------------------------------------------
describe("getOrigin", () => {
  it("should extract origin from a full URL", () => {
    expect(getOrigin("https://example.com/docs/page")).toBe(
      "https://example.com",
    );
  });

  it("should include port in origin when non-default", () => {
    expect(getOrigin("https://example.com:8443/path")).toBe(
      "https://example.com:8443",
    );
  });

  it("should include http protocol", () => {
    expect(getOrigin("http://example.com/page")).toBe("http://example.com");
  });

  it("should strip path, query, and fragment from origin", () => {
    expect(getOrigin("https://example.com/path?q=1#frag")).toBe(
      "https://example.com",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. fetchRobotsTxt
// ---------------------------------------------------------------------------
describe("fetchRobotsTxt", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should parse a valid robots.txt and return a RobotsCacheEntry", async () => {
    const robotsTxtContent = [
      "User-agent: *",
      "Disallow: /private/",
      "Crawl-delay: 2",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxtContent,
    } as unknown as Response);

    const entry = await fetchRobotsTxt(
      "https://example.com",
      "website-fetch/1.0",
    );

    expect(entry).toBeDefined();
    expect(entry.robot).toBeDefined();
    expect(typeof entry.robot.isAllowed).toBe("function");
    // /private/ should be disallowed
    expect(entry.robot.isAllowed("https://example.com/private/secret", "*")).toBe(
      false,
    );
    // / should be allowed
    expect(entry.robot.isAllowed("https://example.com/public", "*")).not.toBe(
      false,
    );
  });

  it("should extract Crawl-delay from robots.txt", async () => {
    const robotsTxtContent = [
      "User-agent: website-fetch/1.0",
      "Crawl-delay: 5",
      "",
      "User-agent: *",
      "Crawl-delay: 2",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxtContent,
    } as unknown as Response);

    const entry = await fetchRobotsTxt(
      "https://example.com",
      "website-fetch/1.0",
    );

    expect(entry.crawlDelay).toBe(5);
  });

  it("should return undefined crawlDelay when no Crawl-delay directive", async () => {
    const robotsTxtContent = [
      "User-agent: *",
      "Disallow: /admin/",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxtContent,
    } as unknown as Response);

    const entry = await fetchRobotsTxt(
      "https://example.com",
      "website-fetch/1.0",
    );

    expect(entry.crawlDelay).toBeUndefined();
  });

  it("should return allow-all entry when fetch returns non-200 (e.g., 404)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as unknown as Response);

    const entry = await fetchRobotsTxt(
      "https://example.com",
      "website-fetch/1.0",
    );

    // Allow-all means everything is allowed
    expect(entry.robot.isAllowed("https://example.com/anything", "*")).not.toBe(
      false,
    );
    expect(entry.crawlDelay).toBeUndefined();
  });

  it("should return allow-all entry on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("DNS failure"));

    const entry = await fetchRobotsTxt(
      "https://example.com",
      "website-fetch/1.0",
    );

    expect(entry.robot.isAllowed("https://example.com/anything", "*")).not.toBe(
      false,
    );
    expect(entry.crawlDelay).toBeUndefined();
  });

  it("should return allow-all entry on timeout (abort)", async () => {
    // Simulate an abort error
    globalThis.fetch = vi.fn().mockRejectedValueOnce(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    const entry = await fetchRobotsTxt(
      "https://example.com",
      "website-fetch/1.0",
      100,
    );

    expect(entry.robot.isAllowed("https://example.com/anything", "*")).not.toBe(
      false,
    );
    expect(entry.crawlDelay).toBeUndefined();
  });

  it("should send the correct User-Agent header in the request", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "User-agent: *\nAllow: /",
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    await fetchRobotsTxt("https://example.com", "my-custom-bot/2.0");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe("https://example.com/robots.txt");
    expect(callArgs[1].headers["User-Agent"]).toBe("my-custom-bot/2.0");
  });
});

// ---------------------------------------------------------------------------
// 3. isUrlAllowed - with caching
// ---------------------------------------------------------------------------
describe("isUrlAllowed", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return true for allowed URLs", async () => {
    const robotsTxt = "User-agent: *\nDisallow: /private/\n";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);

    const cache: RobotsCache = new Map();
    const allowed = await isUrlAllowed(
      "https://example.com/public/page",
      cache,
      "website-fetch/1.0",
    );

    expect(allowed).toBe(true);
  });

  it("should return false for disallowed URLs", async () => {
    const robotsTxt = "User-agent: *\nDisallow: /private/\n";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);

    const cache: RobotsCache = new Map();
    const allowed = await isUrlAllowed(
      "https://example.com/private/secret",
      cache,
      "website-fetch/1.0",
    );

    expect(allowed).toBe(false);
  });

  it("should cache robots.txt per domain (only fetched once)", async () => {
    const robotsTxt = "User-agent: *\nDisallow: /admin/\n";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    const cache: RobotsCache = new Map();

    // First call - should fetch
    await isUrlAllowed(
      "https://example.com/page1",
      cache,
      "website-fetch/1.0",
    );

    // Second call to same domain - should use cache
    await isUrlAllowed(
      "https://example.com/page2",
      cache,
      "website-fetch/1.0",
    );

    // Third call to same domain - still cached
    await isUrlAllowed(
      "https://example.com/admin/config",
      cache,
      "website-fetch/1.0",
    );

    // fetch should have been called only ONCE for robots.txt
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect(cache.has("https://example.com")).toBe(true);
  });

  it("should fetch robots.txt separately for different domains", async () => {
    const robotsTxt = "User-agent: *\nAllow: /\n";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);
    globalThis.fetch = mockFetch;

    const cache: RobotsCache = new Map();

    await isUrlAllowed(
      "https://example.com/page",
      cache,
      "website-fetch/1.0",
    );
    await isUrlAllowed(
      "https://other.com/page",
      cache,
      "website-fetch/1.0",
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it("should treat undefined from robots-parser isAllowed as allowed", async () => {
    // Empty robots.txt returns undefined for isAllowed (no matching rule)
    const robotsTxt = "";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);

    const cache: RobotsCache = new Map();
    const allowed = await isUrlAllowed(
      "https://example.com/any-page",
      cache,
      "website-fetch/1.0",
    );

    expect(allowed).toBe(true);
  });

  it("should treat robots.txt fetch failure as allow-all", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

    const cache: RobotsCache = new Map();
    const allowed = await isUrlAllowed(
      "https://example.com/any-page",
      cache,
      "website-fetch/1.0",
    );

    expect(allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. getCrawlDelay
// ---------------------------------------------------------------------------
describe("getCrawlDelay", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return crawl delay from cache for a known domain", async () => {
    const robotsTxt = "User-agent: *\nCrawl-delay: 3\n";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);

    const cache: RobotsCache = new Map();
    // Populate cache by calling isUrlAllowed
    await isUrlAllowed(
      "https://example.com/page",
      cache,
      "*",
    );

    const delay = getCrawlDelay("https://example.com", cache);
    expect(delay).toBe(3);
  });

  it("should return undefined for unknown domain (not in cache)", () => {
    const cache: RobotsCache = new Map();
    const delay = getCrawlDelay("https://unknown.com", cache);
    expect(delay).toBeUndefined();
  });

  it("should return undefined when robots.txt has no Crawl-delay", async () => {
    const robotsTxt = "User-agent: *\nDisallow: /admin/\n";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => robotsTxt,
    } as unknown as Response);

    const cache: RobotsCache = new Map();
    await isUrlAllowed(
      "https://example.com/page",
      cache,
      "website-fetch/1.0",
    );

    const delay = getCrawlDelay("https://example.com", cache);
    expect(delay).toBeUndefined();
  });
});

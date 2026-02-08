import { describe, it, expect } from "vitest";
import { normalizeUrl, VisitedSet, buildFetchResult } from "../crawler/base.js";
import type { FetchedPage, SkippedPage } from "../types.js";

// ---------------------------------------------------------------------------
// 1. normalizeUrl
// ---------------------------------------------------------------------------
describe("normalizeUrl", () => {
  describe("trailing slash stripping", () => {
    it("should strip trailing slash from pathname", () => {
      const result = normalizeUrl("https://example.com/docs/");
      expect(result).toBe("https://example.com/docs");
    });

    it("should not strip trailing slash when pathname is just /", () => {
      const result = normalizeUrl("https://example.com/");
      expect(result).toBe("https://example.com/");
    });

    it("should not modify URLs without trailing slash", () => {
      const result = normalizeUrl("https://example.com/docs");
      expect(result).toBe("https://example.com/docs");
    });

    it("should strip trailing slash from deeply nested paths", () => {
      const result = normalizeUrl("https://example.com/a/b/c/d/");
      expect(result).toBe("https://example.com/a/b/c/d");
    });
  });

  describe("fragment stripping", () => {
    it("should strip fragment from URL", () => {
      const result = normalizeUrl("https://example.com/docs#section");
      expect(result).toBe("https://example.com/docs");
    });

    it("should strip fragment with trailing slash", () => {
      const result = normalizeUrl("https://example.com/docs/#section");
      expect(result).toBe("https://example.com/docs");
    });
  });

  describe("query parameter stripping", () => {
    it("should strip query parameters from URL", () => {
      const result = normalizeUrl("https://example.com/docs?page=1&sort=asc");
      expect(result).toBe("https://example.com/docs");
    });

    it("should strip query parameters and fragment together", () => {
      const result = normalizeUrl(
        "https://example.com/docs?page=1#section",
      );
      expect(result).toBe("https://example.com/docs");
    });
  });

  describe("hostname lowercasing", () => {
    it("should lowercase hostname", () => {
      const result = normalizeUrl("https://EXAMPLE.COM/docs");
      expect(result).toBe("https://example.com/docs");
    });

    it("should lowercase mixed-case hostname", () => {
      const result = normalizeUrl("https://Example.Com/Page");
      // Pathname case should be preserved, hostname lowered
      expect(result).toBe("https://example.com/Page");
    });
  });

  describe("combined normalization", () => {
    it("should normalize hostname, strip trailing slash, query, and fragment all at once", () => {
      const result = normalizeUrl(
        "https://EXAMPLE.COM/docs/?page=1#top",
      );
      expect(result).toBe("https://example.com/docs");
    });
  });

  describe("invalid URLs", () => {
    it("should return the original string for invalid URLs", () => {
      const result = normalizeUrl("not-a-url");
      expect(result).toBe("not-a-url");
    });

    it("should return the original string for empty string", () => {
      const result = normalizeUrl("");
      expect(result).toBe("");
    });
  });

  describe("deduplication equivalence", () => {
    it("should produce the same result for URL with and without trailing slash", () => {
      expect(normalizeUrl("https://example.com/docs")).toBe(
        normalizeUrl("https://example.com/docs/"),
      );
    });

    it("should produce the same result for URL with and without fragment", () => {
      expect(normalizeUrl("https://example.com/docs")).toBe(
        normalizeUrl("https://example.com/docs#section"),
      );
    });

    it("should produce the same result for URL with and without query params", () => {
      expect(normalizeUrl("https://example.com/docs")).toBe(
        normalizeUrl("https://example.com/docs?page=1"),
      );
    });

    it("should produce the same result for different hostname casing", () => {
      expect(normalizeUrl("https://example.com/docs")).toBe(
        normalizeUrl("https://EXAMPLE.COM/docs"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 2. VisitedSet
// ---------------------------------------------------------------------------
describe("VisitedSet", () => {
  it("should report has() as false for URLs not added", () => {
    const visited = new VisitedSet();
    expect(visited.has("https://example.com/page")).toBe(false);
  });

  it("should report has() as true for URLs that have been added", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/page");
    expect(visited.has("https://example.com/page")).toBe(true);
  });

  it("should normalize URLs when checking has()", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/docs");
    // Should find the URL with trailing slash because normalization strips it
    expect(visited.has("https://example.com/docs/")).toBe(true);
  });

  it("should normalize URLs when adding", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/docs/");
    // Should find the URL without trailing slash
    expect(visited.has("https://example.com/docs")).toBe(true);
  });

  it("should treat URLs with different fragments as the same URL", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/docs#section1");
    expect(visited.has("https://example.com/docs#section2")).toBe(true);
    expect(visited.has("https://example.com/docs")).toBe(true);
  });

  it("should treat URLs with different query params as the same URL", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/docs?page=1");
    expect(visited.has("https://example.com/docs?page=2")).toBe(true);
    expect(visited.has("https://example.com/docs")).toBe(true);
  });

  it("should treat URLs with different hostname casing as the same URL", () => {
    const visited = new VisitedSet();
    visited.add("https://EXAMPLE.COM/docs");
    expect(visited.has("https://example.com/docs")).toBe(true);
  });

  it("should track size correctly", () => {
    const visited = new VisitedSet();
    expect(visited.size).toBe(0);

    visited.add("https://example.com/page1");
    expect(visited.size).toBe(1);

    visited.add("https://example.com/page2");
    expect(visited.size).toBe(2);
  });

  it("should not increment size for duplicate URLs", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/docs");
    visited.add("https://example.com/docs/"); // Same URL after normalization
    expect(visited.size).toBe(1);
  });

  it("should distinguish different paths", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/page1");
    expect(visited.has("https://example.com/page2")).toBe(false);
  });

  it("should distinguish different domains", () => {
    const visited = new VisitedSet();
    visited.add("https://example.com/page");
    expect(visited.has("https://other.com/page")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. buildFetchResult
// ---------------------------------------------------------------------------
describe("buildFetchResult", () => {
  it("should return a FetchResult with correct structure", () => {
    const pages: FetchedPage[] = [
      {
        url: "https://example.com",
        html: "<html></html>",
        markdown: "# Example",
        statusCode: 200,
        headers: {},
        fetchedAt: new Date(),
        depth: 0,
      },
    ];
    const skipped: SkippedPage[] = [];
    const startTime = Date.now() - 100;

    const result = buildFetchResult(pages, skipped, "./output", startTime);

    expect(result.pages).toBe(pages);
    expect(result.skipped).toBe(skipped);
    expect(result.outputPath).toBe("./output");
    expect(result.stats.totalPages).toBe(1);
    expect(result.stats.totalSkipped).toBe(0);
    expect(result.stats.duration).toBeGreaterThanOrEqual(0);
  });

  it("should count totalPages and totalSkipped correctly", () => {
    const pages: FetchedPage[] = [
      {
        url: "https://example.com/p1",
        html: "",
        markdown: "",
        statusCode: 200,
        headers: {},
        fetchedAt: new Date(),
        depth: 0,
      },
      {
        url: "https://example.com/p2",
        html: "",
        markdown: "",
        statusCode: 200,
        headers: {},
        fetchedAt: new Date(),
        depth: 1,
      },
    ];
    const skipped: SkippedPage[] = [
      { url: "https://example.com/err", reason: "Error" },
      { url: "https://example.com/deep", reason: "Exceeds max depth" },
      { url: "https://example.com/skip", reason: "Some reason" },
    ];
    const startTime = Date.now() - 500;

    const result = buildFetchResult(pages, skipped, "/out", startTime);

    expect(result.stats.totalPages).toBe(2);
    expect(result.stats.totalSkipped).toBe(3);
  });

  it("should calculate duration as approximately Date.now() - startTime", () => {
    const startTime = Date.now() - 250;
    const result = buildFetchResult([], [], "./output", startTime);

    // Duration should be approximately 250ms (allowing some tolerance)
    expect(result.stats.duration).toBeGreaterThanOrEqual(200);
    expect(result.stats.duration).toBeLessThan(1000);
  });

  it("should handle empty pages and skipped arrays", () => {
    const result = buildFetchResult([], [], "./output", Date.now());

    expect(result.pages).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.stats.totalPages).toBe(0);
    expect(result.stats.totalSkipped).toBe(0);
  });
});

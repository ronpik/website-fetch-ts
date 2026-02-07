import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SingleFileWriter } from "../output/single-file.js";
import type { FetchedPage } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal FetchedPage for testing. */
function makePage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: "https://example.com/page",
    html: "<h1>Page</h1>",
    statusCode: 200,
    headers: {},
    fetchedAt: new Date("2026-02-08T12:00:00Z"),
    markdown: "# Page\n\nSome content.",
    title: "Page",
    depth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. SingleFileWriter — Unit tests (output format, no disk I/O checks)
// ---------------------------------------------------------------------------
describe("SingleFileWriter", () => {
  let tempDir: string;
  let writer: SingleFileWriter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "single-file-test-"));
    writer = new SingleFileWriter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1a. File path and return value
  // -------------------------------------------------------------------------
  describe("output file path", () => {
    it("should write output to outputDir/aggregated.md", async () => {
      const pages = [makePage()];
      const filePath = await writer.write(
        pages,
        tempDir,
        "https://example.com",
      );

      expect(filePath).toBe(join(tempDir, "aggregated.md"));
    });

    it("should return the file path as a string", async () => {
      const pages = [makePage()];
      const filePath = await writer.write(
        pages,
        tempDir,
        "https://example.com",
      );

      expect(typeof filePath).toBe("string");
    });

    it("should create the output directory if it does not exist", async () => {
      const nestedDir = join(tempDir, "sub", "dir");
      const pages = [makePage()];

      const filePath = await writer.write(
        pages,
        nestedDir,
        "https://example.com",
      );

      expect(filePath).toBe(join(nestedDir, "aggregated.md"));
      // Verify file was actually written
      const content = await readFile(filePath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 1b. Header format
  // -------------------------------------------------------------------------
  describe("header format", () => {
    it("should include correct domain from root URL as header", async () => {
      const pages = [makePage()];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toMatch(/^# Aggregated Content: example\.com\n/);
    });

    it("should include hostname and path for root URL with path", async () => {
      const pages = [makePage()];
      await writer.write(pages, tempDir, "https://example.com/docs");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toMatch(
        /^# Aggregated Content: example\.com\/docs\n/,
      );
    });

    it("should strip trailing slash from root URL path in header", async () => {
      const pages = [makePage()];
      await writer.write(pages, tempDir, "https://example.com/docs/");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toMatch(
        /^# Aggregated Content: example\.com\/docs\n/,
      );
    });

    it("should use only hostname when root URL is just the domain", async () => {
      const pages = [makePage()];
      await writer.write(pages, tempDir, "https://example.com/");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toMatch(/^# Aggregated Content: example\.com\n/);
    });

    it("should include deep path in header label for deep root URL", async () => {
      const pages = [makePage()];
      await writer.write(
        pages,
        tempDir,
        "https://example.com/docs/api/v2",
      );

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toMatch(
        /^# Aggregated Content: example\.com\/docs\/api\/v2\n/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 1c. Page sections format
  // -------------------------------------------------------------------------
  describe("page section format", () => {
    it("should have source URL heading for each page", async () => {
      const pages = [
        makePage({ url: "https://example.com/page-1", markdown: "Content 1" }),
        makePage({ url: "https://example.com/page-2", markdown: "Content 2" }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain("## Source: https://example.com/page-1");
      expect(content).toContain("## Source: https://example.com/page-2");
    });

    it("should have horizontal rule separators before each page section", async () => {
      const pages = [
        makePage({ url: "https://example.com/a", markdown: "Content A" }),
        makePage({ url: "https://example.com/b", markdown: "Content B" }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // Each section should start with ---
      const sections = content.split("---\n## Source:");
      // First element is the header, remaining are page sections
      expect(sections.length).toBe(3); // header + 2 sections
    });

    it("should include page markdown content after the source heading", async () => {
      const pages = [
        makePage({
          url: "https://example.com/page",
          markdown: "# Hello World\n\nThis is the body.",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain("# Hello World\n\nThis is the body.");
    });

    it("should end with a trailing newline", async () => {
      const pages = [makePage()];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 1d. No front matter in output
  // -------------------------------------------------------------------------
  describe("no front matter", () => {
    it("should not include YAML front matter delimiters in the output", async () => {
      const pages = [
        makePage({
          url: "https://example.com/page",
          markdown: "# Page content",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // The file should NOT start with --- (front matter).
      // It should start with # Aggregated Content
      expect(content.startsWith("# Aggregated Content:")).toBe(true);

      // The --- that appear should be horizontal rules (separators),
      // not YAML front matter markers. Front matter would have --- at line 1
      // followed by key:value pairs then another ---.
      const lines = content.split("\n");
      expect(lines[0]).toMatch(/^# Aggregated Content:/);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Depth-first ordering
  // -------------------------------------------------------------------------
  describe("depth-first ordering", () => {
    it("should concatenate pages in correct depth-first order", async () => {
      const pages = [
        makePage({
          url: "https://example.com/b",
          markdown: "B content",
        }),
        makePage({
          url: "https://example.com/a/child",
          markdown: "A-child content",
        }),
        makePage({
          url: "https://example.com/a",
          markdown: "A content",
        }),
        makePage({
          url: "https://example.com/",
          markdown: "Root content",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // Expected order: root, a, a/child, b
      const rootIndex = content.indexOf("Root content");
      const aIndex = content.indexOf("A content");
      const aChildIndex = content.indexOf("A-child content");
      const bIndex = content.indexOf("B content");

      expect(rootIndex).toBeLessThan(aIndex);
      expect(aIndex).toBeLessThan(aChildIndex);
      expect(aChildIndex).toBeLessThan(bIndex);
    });

    it("should place parent pages before children", async () => {
      const pages = [
        makePage({
          url: "https://example.com/docs/api/users",
          markdown: "Users",
        }),
        makePage({
          url: "https://example.com/docs",
          markdown: "Docs root",
        }),
        makePage({
          url: "https://example.com/docs/api",
          markdown: "API root",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      const docsIndex = content.indexOf("Docs root");
      const apiIndex = content.indexOf("API root");
      const usersIndex = content.indexOf("Users");

      expect(docsIndex).toBeLessThan(apiIndex);
      expect(apiIndex).toBeLessThan(usersIndex);
    });

    it("should sort sibling pages at same depth lexicographically", async () => {
      const pages = [
        makePage({
          url: "https://example.com/docs/zebra",
          markdown: "Zebra content",
        }),
        makePage({
          url: "https://example.com/docs/alpha",
          markdown: "Alpha content",
        }),
        makePage({
          url: "https://example.com/docs/middle",
          markdown: "Middle content",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      const alphaIndex = content.indexOf("Alpha content");
      const middleIndex = content.indexOf("Middle content");
      const zebraIndex = content.indexOf("Zebra content");

      expect(alphaIndex).toBeLessThan(middleIndex);
      expect(middleIndex).toBeLessThan(zebraIndex);
    });

    it("should not mutate the original pages array", async () => {
      const pages = [
        makePage({
          url: "https://example.com/b",
          markdown: "B",
        }),
        makePage({
          url: "https://example.com/a",
          markdown: "A",
        }),
      ];

      const originalFirstUrl = pages[0].url;

      await writer.write(pages, tempDir, "https://example.com");

      // Original array should not be reordered
      expect(pages[0].url).toBe(originalFirstUrl);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("should handle a single page with no separators needed between pages", async () => {
      const pages = [
        makePage({
          url: "https://example.com/only-page",
          markdown: "# Only Page\n\nThis is the only page.",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // Should still have header and source heading
      expect(content).toContain("# Aggregated Content: example.com");
      expect(content).toContain("## Source: https://example.com/only-page");
      expect(content).toContain("# Only Page\n\nThis is the only page.");

      // There should be exactly one --- (one separator for the single section)
      const hrMatches = content.match(/^---$/gm);
      expect(hrMatches).toHaveLength(1);
    });

    it("should handle empty pages array", async () => {
      const pages: FetchedPage[] = [];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // Should still have the header
      expect(content).toContain("# Aggregated Content: example.com");
      // No page sections
      expect(content).not.toContain("## Source:");
      expect(content).not.toContain("---");
    });

    it("should handle pages with very large content", async () => {
      const largeMarkdown = "# Large Page\n\n" + "Lorem ipsum. ".repeat(10000);
      const pages = [
        makePage({
          url: "https://example.com/large",
          markdown: largeMarkdown,
        }),
      ];

      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain(largeMarkdown);
    });

    it("should handle root URL with deep path in header", async () => {
      const pages = [
        makePage({
          url: "https://example.com/docs/v2/api",
          markdown: "API content",
        }),
      ];
      await writer.write(
        pages,
        tempDir,
        "https://example.com/docs/v2",
      );

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain(
        "# Aggregated Content: example.com/docs/v2",
      );
    });

    it("should handle pages with empty markdown content", async () => {
      const pages = [
        makePage({
          url: "https://example.com/empty",
          markdown: "",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain("## Source: https://example.com/empty");
    });

    it("should handle pages with markdown containing --- (horizontal rules)", async () => {
      const pages = [
        makePage({
          url: "https://example.com/page-with-hr",
          markdown: "# Title\n\n---\n\nContent after horizontal rule",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain("Content after horizontal rule");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Full output format verification
  // -------------------------------------------------------------------------
  describe("full output format", () => {
    it("should produce correctly structured output with multiple pages", async () => {
      const pages = [
        makePage({
          url: "https://example.com/",
          markdown: "Home content",
        }),
        makePage({
          url: "https://example.com/about",
          markdown: "About content",
        }),
        makePage({
          url: "https://example.com/docs",
          markdown: "Docs content",
        }),
      ];

      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // Verify overall structure:
      // 1. Starts with # Aggregated Content: example.com
      // 2. Has --- separator before each section
      // 3. Each section has ## Source: <url>
      // 4. Each section has markdown content
      // 5. Ends with newline
      const expectedPattern = [
        "# Aggregated Content: example.com",
        "",
        "---",
        "## Source: https://example.com/",
        "",
        "Home content",
        "",
        "---",
        "## Source: https://example.com/about",
        "",
        "About content",
        "",
        "---",
        "## Source: https://example.com/docs",
        "",
        "Docs content",
        "",
      ].join("\n");

      expect(content).toBe(expectedPattern);
    });

    it("should match expected format for a single page", async () => {
      const pages = [
        makePage({
          url: "https://example.com/only",
          markdown: "Only content",
        }),
      ];

      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      const expected = [
        "# Aggregated Content: example.com",
        "",
        "---",
        "## Source: https://example.com/only",
        "",
        "Only content",
        "",
      ].join("\n");

      expect(content).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Multiple pages at same depth
  // -------------------------------------------------------------------------
  describe("multiple pages at same depth", () => {
    it("should sort pages at same depth alphabetically by URL path", async () => {
      const pages = [
        makePage({
          url: "https://example.com/c-page",
          markdown: "C page",
        }),
        makePage({
          url: "https://example.com/a-page",
          markdown: "A page",
        }),
        makePage({
          url: "https://example.com/b-page",
          markdown: "B page",
        }),
      ];
      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      const aIdx = content.indexOf("A page");
      const bIdx = content.indexOf("B page");
      const cIdx = content.indexOf("C page");

      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    });

    it("should handle a mix of depths sorted correctly", async () => {
      const pages = [
        makePage({
          url: "https://example.com/z",
          markdown: "Z content",
        }),
        makePage({
          url: "https://example.com/a/b",
          markdown: "A-B content",
        }),
        makePage({
          url: "https://example.com/a",
          markdown: "A content",
        }),
        makePage({
          url: "https://example.com/m",
          markdown: "M content",
        }),
        makePage({
          url: "https://example.com/a/c",
          markdown: "A-C content",
        }),
      ];

      await writer.write(pages, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");

      // Expected: a, a/b, a/c, m, z
      const aIdx = content.indexOf("A content");
      const abIdx = content.indexOf("A-B content");
      const acIdx = content.indexOf("A-C content");
      const mIdx = content.indexOf("M content");
      const zIdx = content.indexOf("Z content");

      expect(aIdx).toBeLessThan(abIdx);
      expect(abIdx).toBeLessThan(acIdx);
      expect(acIdx).toBeLessThan(mIdx);
      expect(mIdx).toBeLessThan(zIdx);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Overwrite behavior
  // -------------------------------------------------------------------------
  describe("overwrite behavior", () => {
    it("should overwrite existing aggregated.md on subsequent writes", async () => {
      const pages1 = [
        makePage({
          url: "https://example.com/first",
          markdown: "First write",
        }),
      ];
      const pages2 = [
        makePage({
          url: "https://example.com/second",
          markdown: "Second write",
        }),
      ];

      await writer.write(pages1, tempDir, "https://example.com");
      await writer.write(pages2, tempDir, "https://example.com");

      const content = await readFile(join(tempDir, "aggregated.md"), "utf-8");
      expect(content).toContain("Second write");
      expect(content).not.toContain("First write");
    });
  });
});

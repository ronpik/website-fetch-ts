import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  urlToPath,
  sanitizeFilename,
  addFrontMatter,
  pathToMirrorFile,
  pathToFlatFile,
  MirrorWriter,
  FlatWriter,
  createOutputWriter,
} from "../output/index.js";
import type { FetchedPage } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal FetchedPage for testing. */
function makePage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: "https://example.com/docs/api/auth",
    html: "<h1>Auth</h1>",
    statusCode: 200,
    headers: {},
    fetchedAt: new Date("2026-02-06T12:00:00Z"),
    markdown: "# Auth\n\nSome content here.",
    title: "Auth",
    depth: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. urlToPath — pure utility
// ---------------------------------------------------------------------------
describe("urlToPath", () => {
  it("should extract pathname from a full URL", () => {
    expect(urlToPath("https://example.com/docs/api/auth")).toBe(
      "/docs/api/auth",
    );
  });

  it("should return / for root URL", () => {
    expect(urlToPath("https://example.com/")).toBe("/");
  });

  it("should preserve trailing slash", () => {
    expect(urlToPath("https://example.com/docs/")).toBe("/docs/");
  });

  it("should strip query parameters", () => {
    expect(urlToPath("https://example.com/docs?version=2&lang=en")).toBe(
      "/docs",
    );
  });

  it("should strip fragments", () => {
    expect(urlToPath("https://example.com/docs#section-2")).toBe("/docs");
  });

  it("should strip both query parameters and fragments", () => {
    expect(urlToPath("https://example.com/docs?v=1#top")).toBe("/docs");
  });

  it("should decode URL-encoded characters", () => {
    expect(urlToPath("https://example.com/docs/my%20page")).toBe(
      "/docs/my page",
    );
  });

  it("should decode %2F encoded slashes in URL", () => {
    // Note: the URL spec treats %2F differently depending on context,
    // but new URL(...).pathname keeps them decoded or as-is
    const result = urlToPath("https://example.com/a%2Fb");
    // The URL constructor typically does NOT decode %2F in pathname
    // (since / is a delimiter), so it stays as /a%2Fb which decodeURIComponent decodes
    expect(result).toBe("/a/b");
  });
});

// ---------------------------------------------------------------------------
// 2. sanitizeFilename
// ---------------------------------------------------------------------------
describe("sanitizeFilename", () => {
  it("should return the name unchanged for safe names", () => {
    expect(sanitizeFilename("hello-world")).toBe("hello-world");
  });

  it("should replace Windows-unsafe characters with underscores", () => {
    expect(sanitizeFilename('file<>:"|?*name')).toBe("file_______name");
  });

  it("should replace backslashes", () => {
    expect(sanitizeFilename("path\\file")).toBe("path_file");
  });

  it("should remove null bytes", () => {
    expect(sanitizeFilename("file\0name")).toBe("filename");
  });

  it("should collapse multiple consecutive dots", () => {
    expect(sanitizeFilename("file...name")).toBe("file.name");
  });

  it("should trim leading and trailing whitespace", () => {
    expect(sanitizeFilename("  hello  ")).toBe("hello");
  });

  it("should truncate filenames longer than 200 characters", () => {
    const longName = "a".repeat(300);
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(200);
  });

  it("should preserve filenames at exactly 200 characters", () => {
    const name = "a".repeat(200);
    expect(sanitizeFilename(name)).toBe(name);
  });

  it("should preserve filenames shorter than 200 characters", () => {
    const name = "a".repeat(199);
    expect(sanitizeFilename(name)).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// 3. addFrontMatter
// ---------------------------------------------------------------------------
describe("addFrontMatter", () => {
  it("should prepend YAML front matter with source and fetchedAt", () => {
    const result = addFrontMatter("# Hello", {
      source: "https://example.com/docs",
      fetchedAt: "2026-02-06T12:00:00.000Z",
    });

    expect(result).toContain("---");
    expect(result).toContain("source: https://example.com/docs");
    expect(result).toContain("fetchedAt: 2026-02-06T12:00:00.000Z");
  });

  it("should have front matter delimited by --- on its own lines", () => {
    const result = addFrontMatter("# Hello", {
      source: "https://example.com",
    });

    const lines = result.split("\n");
    expect(lines[0]).toBe("---");
    // Find the closing ---
    const closingIndex = lines.indexOf("---", 1);
    expect(closingIndex).toBeGreaterThan(0);
  });

  it("should have valid YAML format (key: value)", () => {
    const result = addFrontMatter("body", {
      source: "https://example.com/page",
      fetchedAt: "2026-02-06T12:00:00.000Z",
    });

    const lines = result.split("\n");
    // Lines between first --- and second ---
    const fmLines = [];
    let inFrontMatter = false;
    for (const line of lines) {
      if (line === "---" && !inFrontMatter) {
        inFrontMatter = true;
        continue;
      }
      if (line === "---" && inFrontMatter) {
        break;
      }
      if (inFrontMatter) {
        fmLines.push(line);
      }
    }

    expect(fmLines.length).toBeGreaterThan(0);
    for (const fmLine of fmLines) {
      // Each line should match key: value pattern
      expect(fmLine).toMatch(/^[\w]+: .+$/);
    }
  });

  it("should place front matter before the markdown body", () => {
    const body = "# My Page\n\nContent here.";
    const result = addFrontMatter(body, { source: "https://example.com" });

    // The markdown body should appear after the closing ---
    const closingIndex = result.indexOf("---", 4); // skip opening ---
    const afterFrontMatter = result.substring(closingIndex + 3);
    expect(afterFrontMatter).toContain("# My Page");
    expect(afterFrontMatter).toContain("Content here.");
  });

  it("should handle empty metadata", () => {
    const result = addFrontMatter("body", {});
    expect(result).toBe("---\n---\nbody");
  });

  it("should handle multiple metadata keys", () => {
    const result = addFrontMatter("body", {
      source: "https://example.com",
      fetchedAt: "2026-01-01T00:00:00Z",
      title: "My Page",
    });

    expect(result).toContain("source: https://example.com");
    expect(result).toContain("fetchedAt: 2026-01-01T00:00:00Z");
    expect(result).toContain("title: My Page");
  });
});

// ---------------------------------------------------------------------------
// 4. pathToMirrorFile
// ---------------------------------------------------------------------------
describe("pathToMirrorFile", () => {
  it("should map /docs/api/auth to output/docs/api/auth.md", () => {
    const result = pathToMirrorFile("/docs/api/auth", "output");
    expect(result).toBe(join("output", "docs", "api", "auth.md"));
  });

  it("should map / (root) to output/index.md", () => {
    const result = pathToMirrorFile("/", "output");
    expect(result).toBe(join("output", "index.md"));
  });

  it("should map /docs/ (trailing slash) to output/docs/index.md", () => {
    const result = pathToMirrorFile("/docs/", "output");
    expect(result).toBe(join("output", "docs", "index.md"));
  });

  it("should map a deep path correctly", () => {
    const result = pathToMirrorFile("/a/b/c/d/e", "out");
    expect(result).toBe(join("out", "a", "b", "c", "d", "e.md"));
  });

  it("should sanitize path segments with unsafe characters", () => {
    const result = pathToMirrorFile('/docs/my<page>', "output");
    // < and > are replaced with _
    expect(result).toBe(join("output", "docs", "my_page_.md"));
  });

  it("should handle an empty string path as root", () => {
    const result = pathToMirrorFile("", "output");
    expect(result).toBe(join("output", "index.md"));
  });
});

// ---------------------------------------------------------------------------
// 5. pathToFlatFile
// ---------------------------------------------------------------------------
describe("pathToFlatFile", () => {
  it("should map /docs/api/auth to output/docs_api_auth.md", () => {
    const result = pathToFlatFile("/docs/api/auth", "output");
    expect(result).toBe(join("output", "docs_api_auth.md"));
  });

  it("should map / (root) to output/index.md", () => {
    const result = pathToFlatFile("/", "output");
    expect(result).toBe(join("output", "index.md"));
  });

  it("should map /docs/ (trailing slash) to output/docs_index.md", () => {
    const result = pathToFlatFile("/docs/", "output");
    expect(result).toBe(join("output", "docs_index.md"));
  });

  it("should map a deep path with underscores", () => {
    const result = pathToFlatFile("/a/b/c/d", "out");
    expect(result).toBe(join("out", "a_b_c_d.md"));
  });

  it("should handle a single-segment path", () => {
    const result = pathToFlatFile("/about", "output");
    expect(result).toBe(join("output", "about.md"));
  });
});

// ---------------------------------------------------------------------------
// 6. MirrorWriter — urlToFilePath (unit, no disk I/O)
// ---------------------------------------------------------------------------
describe("MirrorWriter", () => {
  describe("urlToFilePath", () => {
    it("should map https://example.com/docs/api/auth to output/docs/api/auth.md", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath("https://example.com/docs/api/auth");
      expect(result).toBe(join("output", "docs", "api", "auth.md"));
    });

    it("should map https://example.com/ to output/index.md", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath("https://example.com/");
      expect(result).toBe(join("output", "index.md"));
    });

    it("should map https://example.com/docs/ to output/docs/index.md", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath("https://example.com/docs/");
      expect(result).toBe(join("output", "docs", "index.md"));
    });

    it("should strip query parameters before path mapping", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/docs?version=2",
      );
      expect(result).toBe(join("output", "docs.md"));
    });

    it("should strip fragments before path mapping", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/docs#section-2",
      );
      expect(result).toBe(join("output", "docs.md"));
    });

    it("should handle URL-encoded characters", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/docs/my%20page",
      );
      expect(result).toBe(join("output", "docs", "my page.md"));
    });
  });
});

// ---------------------------------------------------------------------------
// 7. FlatWriter — urlToFilePath (unit, no disk I/O)
// ---------------------------------------------------------------------------
describe("FlatWriter", () => {
  describe("urlToFilePath", () => {
    it("should map https://example.com/docs/api/auth to output/docs_api_auth.md", () => {
      const writer = new FlatWriter("output");
      const result = writer.urlToFilePath("https://example.com/docs/api/auth");
      expect(result).toBe(join("output", "docs_api_auth.md"));
    });

    it("should map https://example.com/ to output/index.md", () => {
      const writer = new FlatWriter("output");
      const result = writer.urlToFilePath("https://example.com/");
      expect(result).toBe(join("output", "index.md"));
    });

    it("should strip query parameters before path mapping", () => {
      const writer = new FlatWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/docs/api?key=val",
      );
      expect(result).toBe(join("output", "docs_api.md"));
    });

    it("should strip fragments before path mapping", () => {
      const writer = new FlatWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/docs/api#bottom",
      );
      expect(result).toBe(join("output", "docs_api.md"));
    });
  });
});

// ---------------------------------------------------------------------------
// 8. MirrorWriter — writePage (integration, disk I/O)
// ---------------------------------------------------------------------------
describe("MirrorWriter writePage (integration)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mirror-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should write a file with front matter to the correct mirror path", async () => {
    const writer = new MirrorWriter(tempDir);
    const page = makePage({
      url: "https://example.com/docs/api/auth",
      markdown: "# Auth API\n\nDetails here.",
      fetchedAt: new Date("2026-02-06T12:00:00Z"),
    });

    const filePath = await writer.writePage(page);

    expect(filePath).toBe(join(tempDir, "docs", "api", "auth.md"));

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("source: https://example.com/docs/api/auth");
    expect(content).toContain("fetchedAt: 2026-02-06T12:00:00.000Z");
    expect(content).toContain("# Auth API");
    expect(content).toContain("Details here.");
  });

  it("should create parent directories as needed", async () => {
    const writer = new MirrorWriter(tempDir);
    const page = makePage({
      url: "https://example.com/deep/nested/path/page",
    });

    const filePath = await writer.writePage(page);

    // Verify directories were created
    const dirStat = await stat(join(tempDir, "deep", "nested", "path"));
    expect(dirStat.isDirectory()).toBe(true);
    expect(filePath).toBe(
      join(tempDir, "deep", "nested", "path", "page.md"),
    );
  });

  it("should write root URL to index.md", async () => {
    const writer = new MirrorWriter(tempDir);
    const page = makePage({ url: "https://example.com/" });

    const filePath = await writer.writePage(page);

    expect(filePath).toBe(join(tempDir, "index.md"));
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("source: https://example.com/");
  });

  it("should write trailing-slash URL to index.md in subdirectory", async () => {
    const writer = new MirrorWriter(tempDir);
    const page = makePage({ url: "https://example.com/docs/" });

    const filePath = await writer.writePage(page);

    expect(filePath).toBe(join(tempDir, "docs", "index.md"));
  });

  it("should write multiple pages and create correct directory structure", async () => {
    const writer = new MirrorWriter(tempDir);

    const pages = [
      makePage({ url: "https://example.com/", markdown: "# Home" }),
      makePage({
        url: "https://example.com/docs/api/auth",
        markdown: "# Auth",
      }),
      makePage({
        url: "https://example.com/docs/api/users",
        markdown: "# Users",
      }),
      makePage({
        url: "https://example.com/docs/guides/getting-started",
        markdown: "# Getting Started",
      }),
    ];

    const writtenPaths: string[] = [];
    for (const page of pages) {
      writtenPaths.push(await writer.writePage(page));
    }

    // Verify all files exist
    expect(writtenPaths).toHaveLength(4);
    for (const p of writtenPaths) {
      const fileStat = await stat(p);
      expect(fileStat.isFile()).toBe(true);
    }

    // Verify directory structure
    const docsApiDir = await readdir(join(tempDir, "docs", "api"));
    expect(docsApiDir).toContain("auth.md");
    expect(docsApiDir).toContain("users.md");

    const guidesDir = await readdir(join(tempDir, "docs", "guides"));
    expect(guidesDir).toContain("getting-started.md");
  });

  it("should overwrite when the same URL is written twice (duplicate)", async () => {
    const writer = new MirrorWriter(tempDir);

    const page1 = makePage({
      url: "https://example.com/docs/page",
      markdown: "# Version 1",
    });
    const page2 = makePage({
      url: "https://example.com/docs/page",
      markdown: "# Version 2",
    });

    await writer.writePage(page1);
    const filePath = await writer.writePage(page2);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Version 2");
    expect(content).not.toContain("# Version 1");
  });
});

// ---------------------------------------------------------------------------
// 9. FlatWriter — writePage (integration, disk I/O)
// ---------------------------------------------------------------------------
describe("FlatWriter writePage (integration)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flat-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should write a file with front matter to the correct flat path", async () => {
    const writer = new FlatWriter(tempDir);
    const page = makePage({
      url: "https://example.com/docs/api/auth",
      markdown: "# Auth API",
      fetchedAt: new Date("2026-02-06T12:00:00Z"),
    });

    const filePath = await writer.writePage(page);

    expect(filePath).toBe(join(tempDir, "docs_api_auth.md"));

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("source: https://example.com/docs/api/auth");
    expect(content).toContain("fetchedAt: 2026-02-06T12:00:00.000Z");
    expect(content).toContain("# Auth API");
  });

  it("should write root URL to index.md", async () => {
    const writer = new FlatWriter(tempDir);
    const page = makePage({ url: "https://example.com/" });

    const filePath = await writer.writePage(page);

    expect(filePath).toBe(join(tempDir, "index.md"));
  });

  it("should write multiple pages as flat files", async () => {
    const writer = new FlatWriter(tempDir);

    const pages = [
      makePage({ url: "https://example.com/", markdown: "# Home" }),
      makePage({
        url: "https://example.com/docs/api/auth",
        markdown: "# Auth",
      }),
      makePage({
        url: "https://example.com/docs/api/users",
        markdown: "# Users",
      }),
      makePage({
        url: "https://example.com/about",
        markdown: "# About",
      }),
    ];

    for (const page of pages) {
      await writer.writePage(page);
    }

    // All files should be in the single tempDir (no subdirectories with .md files)
    const files = await readdir(tempDir);
    expect(files).toContain("index.md");
    expect(files).toContain("docs_api_auth.md");
    expect(files).toContain("docs_api_users.md");
    expect(files).toContain("about.md");
    expect(files).toHaveLength(4);
  });

  it("should overwrite when the same URL is written twice (duplicate)", async () => {
    const writer = new FlatWriter(tempDir);

    const page1 = makePage({
      url: "https://example.com/docs/page",
      markdown: "# First",
    });
    const page2 = makePage({
      url: "https://example.com/docs/page",
      markdown: "# Second",
    });

    await writer.writePage(page1);
    const filePath = await writer.writePage(page2);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Second");
    expect(content).not.toContain("# First");
  });

  it("should create the output directory if it does not exist", async () => {
    const nestedOut = join(tempDir, "sub", "dir");
    const writer = new FlatWriter(nestedOut);
    const page = makePage({ url: "https://example.com/about" });

    await writer.writePage(page);

    const dirStat = await stat(nestedOut);
    expect(dirStat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. createOutputWriter (factory)
// ---------------------------------------------------------------------------
describe("createOutputWriter", () => {
  it("should return a MirrorWriter when outputStructure is mirror", () => {
    const config = {
      url: "https://example.com",
      mode: "simple" as const,
      maxDepth: 5,
      maxPages: 100,
      outputDir: "/tmp/test-output",
      outputStructure: "mirror" as const,
      generateIndex: true,
      conversionStrategy: "default" as const,
      optimizeConversion: false,
      delay: 200,
      concurrency: 3,
      respectRobots: true,
      adaptiveRateLimit: true,
    };

    const writer = createOutputWriter(config);
    expect(writer).toBeInstanceOf(MirrorWriter);
  });

  it("should return a FlatWriter when outputStructure is flat", () => {
    const config = {
      url: "https://example.com",
      mode: "simple" as const,
      maxDepth: 5,
      maxPages: 100,
      outputDir: "/tmp/test-output",
      outputStructure: "flat" as const,
      generateIndex: true,
      conversionStrategy: "default" as const,
      optimizeConversion: false,
      delay: 200,
      concurrency: 3,
      respectRobots: true,
      adaptiveRateLimit: true,
    };

    const writer = createOutputWriter(config);
    expect(writer).toBeInstanceOf(FlatWriter);
  });

  it("should pass outputDir from config to the writer", () => {
    const config = {
      url: "https://example.com",
      mode: "simple" as const,
      maxDepth: 5,
      maxPages: 100,
      outputDir: "/my/custom/output",
      outputStructure: "mirror" as const,
      generateIndex: true,
      conversionStrategy: "default" as const,
      optimizeConversion: false,
      delay: 200,
      concurrency: 3,
      respectRobots: true,
      adaptiveRateLimit: true,
    };

    const writer = createOutputWriter(config);
    // Verify the writer uses the correct output dir by checking a file path
    const filePath = writer.urlToFilePath("https://example.com/test");
    expect(filePath).toBe(join("/my/custom/output", "test.md"));
  });
});

// ---------------------------------------------------------------------------
// 11. Edge cases — URLs with special characters
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  describe("URLs with query parameters", () => {
    it("should strip query params in mirror mode", () => {
      const writer = new MirrorWriter("output");
      const withQuery = writer.urlToFilePath(
        "https://example.com/search?q=hello&page=2",
      );
      const withoutQuery = writer.urlToFilePath(
        "https://example.com/search",
      );
      expect(withQuery).toBe(withoutQuery);
    });

    it("should strip query params in flat mode", () => {
      const writer = new FlatWriter("output");
      const withQuery = writer.urlToFilePath(
        "https://example.com/search?q=hello",
      );
      const withoutQuery = writer.urlToFilePath(
        "https://example.com/search",
      );
      expect(withQuery).toBe(withoutQuery);
    });
  });

  describe("URLs with fragments", () => {
    it("should strip fragments in mirror mode", () => {
      const writer = new MirrorWriter("output");
      const withFragment = writer.urlToFilePath(
        "https://example.com/page#section",
      );
      const withoutFragment = writer.urlToFilePath(
        "https://example.com/page",
      );
      expect(withFragment).toBe(withoutFragment);
    });

    it("should strip fragments in flat mode", () => {
      const writer = new FlatWriter("output");
      const withFragment = writer.urlToFilePath(
        "https://example.com/page#section",
      );
      const withoutFragment = writer.urlToFilePath(
        "https://example.com/page",
      );
      expect(withFragment).toBe(withoutFragment);
    });
  });

  describe("URLs with URL-encoded characters", () => {
    it("should decode encoded spaces in mirror mode", () => {
      const writer = new MirrorWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/my%20docs/hello%20world",
      );
      expect(result).toBe(join("output", "my docs", "hello world.md"));
    });

    it("should decode encoded characters in flat mode", () => {
      const writer = new FlatWriter("output");
      const result = writer.urlToFilePath(
        "https://example.com/my%20docs/hello%20world",
      );
      expect(result).toBe(join("output", "my docs_hello world.md"));
    });
  });

  describe("very long URL paths", () => {
    it("should truncate very long path segments via sanitizeFilename", () => {
      const longSegment = "a".repeat(300);
      const result = sanitizeFilename(longSegment);
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it("should handle a very long URL path in mirror mode without error", () => {
      const writer = new MirrorWriter("output");
      const longPath = "/docs/" + "a".repeat(300);
      // Should not throw
      const result = writer.urlToFilePath(
        `https://example.com${longPath}`,
      );
      expect(result).toBeDefined();
      // The filename part should be truncated
      const parts = result.split(sep);
      const filename = parts[parts.length - 1];
      // filename includes .md extension appended to the truncated name
      expect(filename.length).toBeLessThanOrEqual(204); // 200 + ".md" length
    });

    it("should handle a very long URL path in flat mode without error", () => {
      const writer = new FlatWriter("output");
      const longPath =
        "/docs/" + "segment/".repeat(30) + "a".repeat(100);
      const result = writer.urlToFilePath(
        `https://example.com${longPath}`,
      );
      expect(result).toBeDefined();
    });
  });

  describe("duplicate URLs (overwrite behavior)", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "dup-test-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("should overwrite file on duplicate URL in mirror mode", async () => {
      const writer = new MirrorWriter(tempDir);
      await writer.writePage(
        makePage({
          url: "https://example.com/page",
          markdown: "# Old",
        }),
      );
      await writer.writePage(
        makePage({
          url: "https://example.com/page",
          markdown: "# New",
        }),
      );

      const filePath = join(tempDir, "page.md");
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("# New");
      expect(content).not.toContain("# Old");
    });

    it("should overwrite file on duplicate URL in flat mode", async () => {
      const writer = new FlatWriter(tempDir);
      await writer.writePage(
        makePage({
          url: "https://example.com/page",
          markdown: "# Old",
        }),
      );
      await writer.writePage(
        makePage({
          url: "https://example.com/page",
          markdown: "# New",
        }),
      );

      const filePath = join(tempDir, "page.md");
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("# New");
      expect(content).not.toContain("# Old");
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Front matter integration — verify written files have valid front matter
// ---------------------------------------------------------------------------
describe("front matter in written files", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fm-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should include source URL in front matter of mirror-written file", async () => {
    const writer = new MirrorWriter(tempDir);
    const page = makePage({
      url: "https://example.com/docs/intro",
      fetchedAt: new Date("2026-02-06T12:00:00Z"),
    });

    const filePath = await writer.writePage(page);
    const content = await readFile(filePath, "utf-8");

    // Parse front matter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const frontMatter = fmMatch![1];
    expect(frontMatter).toContain(
      "source: https://example.com/docs/intro",
    );
    expect(frontMatter).toContain("fetchedAt: 2026-02-06T12:00:00.000Z");
  });

  it("should include source URL in front matter of flat-written file", async () => {
    const writer = new FlatWriter(tempDir);
    const page = makePage({
      url: "https://example.com/docs/intro",
      fetchedAt: new Date("2026-02-06T12:00:00Z"),
    });

    const filePath = await writer.writePage(page);
    const content = await readFile(filePath, "utf-8");

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const frontMatter = fmMatch![1];
    expect(frontMatter).toContain(
      "source: https://example.com/docs/intro",
    );
    expect(frontMatter).toContain("fetchedAt: 2026-02-06T12:00:00.000Z");
  });

  it("should have front matter delimited by --- at start of file", async () => {
    const writer = new MirrorWriter(tempDir);
    const page = makePage({ url: "https://example.com/about" });

    const filePath = await writer.writePage(page);
    const content = await readFile(filePath, "utf-8");

    expect(content.startsWith("---\n")).toBe(true);
    // Should have two --- delimiters
    const dashes = content.match(/^---$/gm);
    expect(dashes).not.toBeNull();
    expect(dashes!.length).toBeGreaterThanOrEqual(2);
  });
});

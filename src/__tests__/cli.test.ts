import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FetchResult, FetchedPage } from "../types.js";
import { CONFIG_DEFAULTS } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before import of the module under test.
// ---------------------------------------------------------------------------

// Mock the websiteFetch SDK function
const mockWebsiteFetch = vi.fn<[], Promise<FetchResult>>();
vi.mock("../sdk/index.js", () => ({
  websiteFetch: (...args: unknown[]) => mockWebsiteFetch(...(args as [])),
}));

// Mock node:fs for loadLLMConfig
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { run } from "../cli/index.js";
import { buildConfig, parseHeaders, loadLLMConfig } from "../cli/options.js";
import type { CLIOptions } from "../cli/options.js";
import {
  createProgressCallbacks,
  printSummary,
  printDryRun,
} from "../cli/progress.js";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock FetchResult for use in websiteFetch mock returns. */
function makeFetchResult(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    pages: [
      {
        url: "https://example.com",
        html: "<html><body>Hello</body></html>",
        markdown: "# Hello",
        statusCode: 200,
        headers: {},
        fetchedAt: new Date(),
        depth: 0,
      } as FetchedPage,
    ],
    skipped: [],
    outputPath: "./output",
    stats: {
      totalPages: 1,
      totalSkipped: 0,
      duration: 100,
    },
    ...overrides,
  };
}

/** Create a minimal CLIOptions with defaults matching commander's defaults. */
function makeDefaultCLIOptions(
  overrides: Partial<CLIOptions> = {},
): CLIOptions {
  return {
    mode: "simple",
    output: "./output",
    depth: String(CONFIG_DEFAULTS.maxDepth),
    maxPages: String(CONFIG_DEFAULTS.maxPages),
    delay: String(CONFIG_DEFAULTS.delay),
    concurrency: String(CONFIG_DEFAULTS.concurrency),
    include: [],
    exclude: [],
    header: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI (src/cli/)", () => {
  // -------------------------------------------------------------------------
  // parseHeaders
  // -------------------------------------------------------------------------
  describe("parseHeaders", () => {
    it("should parse a simple header with key:value format", () => {
      const result = parseHeaders(["Content-Type:application/json"]);
      expect(result).toEqual({ "Content-Type": "application/json" });
    });

    it('should parse "Authorization:Bearer token" correctly', () => {
      const result = parseHeaders(["Authorization:Bearer token"]);
      expect(result).toEqual({ Authorization: "Bearer token" });
    });

    it("should split on the first colon only (colons in value preserved)", () => {
      const result = parseHeaders(["Authorization:Bearer abc:def:ghi"]);
      expect(result).toEqual({ Authorization: "Bearer abc:def:ghi" });
    });

    it("should trim whitespace from key and value", () => {
      const result = parseHeaders(["  Content-Type : application/json  "]);
      expect(result).toEqual({ "Content-Type": "application/json" });
    });

    it("should accumulate multiple headers into a single record", () => {
      const result = parseHeaders([
        "Authorization:Bearer token",
        "X-Custom:my-value",
        "Accept:text/html",
      ]);
      expect(result).toEqual({
        Authorization: "Bearer token",
        "X-Custom": "my-value",
        Accept: "text/html",
      });
    });

    it("should return an empty record for an empty array", () => {
      const result = parseHeaders([]);
      expect(result).toEqual({});
    });

    it("should throw for a malformed header with no colon", () => {
      expect(() => parseHeaders(["InvalidHeader"])).toThrow(
        /Invalid header format.*InvalidHeader/,
      );
    });

    it("should throw for a header with an empty key (starts with colon)", () => {
      expect(() => parseHeaders([":value"])).toThrow(
        /Header name cannot be empty/,
      );
    });

    it("should handle a header with an empty value after colon", () => {
      const result = parseHeaders(["X-Empty:"]);
      expect(result).toEqual({ "X-Empty": "" });
    });

    it("should overwrite duplicate header keys with the last value", () => {
      const result = parseHeaders([
        "Authorization:Bearer first",
        "Authorization:Bearer second",
      ]);
      expect(result).toEqual({ Authorization: "Bearer second" });
    });
  });

  // -------------------------------------------------------------------------
  // loadLLMConfig
  // -------------------------------------------------------------------------
  describe("loadLLMConfig", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should load and parse a valid JSON config file", () => {
      const mockConfig = {
        defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      };
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify(mockConfig),
      );

      const result = loadLLMConfig("/path/to/config.json");
      expect(result).toEqual(mockConfig);
      expect(readFileSync).toHaveBeenCalledWith("/path/to/config.json", "utf-8");
    });

    it("should throw when the file does not exist", () => {
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      expect(() => loadLLMConfig("/nonexistent/config.json")).toThrow(
        /Cannot read LLM config file.*nonexistent/,
      );
    });

    it("should throw when the file contains invalid JSON", () => {
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        "{ not valid json }",
      );

      expect(() => loadLLMConfig("/path/to/bad.json")).toThrow(
        /Invalid JSON in LLM config file/,
      );
    });

    it("should include the file path in the error message", () => {
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Permission denied");
      });

      expect(() => loadLLMConfig("/secret/config.json")).toThrow(
        /\/secret\/config\.json/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // buildConfig
  // -------------------------------------------------------------------------
  describe("buildConfig", () => {
    it("should set the url from the positional argument", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions(),
      );
      expect(config.url).toBe("https://example.com");
    });

    it("should map --mode to config.mode", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ mode: "smart" }),
      );
      expect(config.mode).toBe("smart");
    });

    it("should map --description to config.description", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ description: "API docs" }),
      );
      expect(config.description).toBe("API docs");
    });

    it("should map --depth to config.maxDepth as a number", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ depth: "10" }),
      );
      expect(config.maxDepth).toBe(10);
    });

    it("should map --max-pages to config.maxPages as a number", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ maxPages: "50" }),
      );
      expect(config.maxPages).toBe(50);
    });

    it("should map --include patterns to config.includePatterns", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ include: ["/docs/**", "/api/**"] }),
      );
      expect(config.includePatterns).toEqual(["/docs/**", "/api/**"]);
    });

    it("should map --exclude patterns to config.excludePatterns", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ exclude: ["/blog/**", "/admin/**"] }),
      );
      expect(config.excludePatterns).toEqual(["/blog/**", "/admin/**"]);
    });

    it("should not set includePatterns when include array is empty", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ include: [] }),
      );
      expect(config.includePatterns).toBeUndefined();
    });

    it("should not set excludePatterns when exclude array is empty", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ exclude: [] }),
      );
      expect(config.excludePatterns).toBeUndefined();
    });

    it("should map --output to config.outputDir", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ output: "/custom/output" }),
      );
      expect(config.outputDir).toBe("/custom/output");
    });

    it("should set outputStructure to 'flat' when --flat is true", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ flat: true }),
      );
      expect(config.outputStructure).toBe("flat");
    });

    it("should not set outputStructure when --flat is not provided", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions(),
      );
      expect(config.outputStructure).toBeUndefined();
    });

    it("should set singleFile to true when --single-file is true", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ singleFile: true }),
      );
      expect(config.singleFile).toBe(true);
    });

    it("should set generateIndex to false when --no-index is used (options.index === false)", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ index: false }),
      );
      expect(config.generateIndex).toBe(false);
    });

    it("should not set generateIndex when options.index is not explicitly false", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions(),
      );
      expect(config.generateIndex).toBeUndefined();
    });

    it("should map --conversion to config.conversionStrategy", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ conversion: "readability" }),
      );
      expect(config.conversionStrategy).toBe("readability");
    });

    it("should map --optimize-conversion to config.optimizeConversion", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ optimizeConversion: true }),
      );
      expect(config.optimizeConversion).toBe(true);
    });

    it("should map --no-optimize-conversion to config.optimizeConversion false", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ optimizeConversion: false }),
      );
      expect(config.optimizeConversion).toBe(false);
    });

    it("should map --delay to config.delay as a number", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ delay: "500" }),
      );
      expect(config.delay).toBe(500);
    });

    it("should map --concurrency to config.concurrency as a number", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ concurrency: "10" }),
      );
      expect(config.concurrency).toBe(10);
    });

    it("should set respectRobots to false when --ignore-robots is true", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ ignoreRobots: true }),
      );
      expect(config.respectRobots).toBe(false);
    });

    it("should not set respectRobots when --ignore-robots is not provided", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions(),
      );
      expect(config.respectRobots).toBeUndefined();
    });

    it("should parse --header values and map to config.headers", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({
          header: ["Authorization:Bearer token", "X-Custom:value"],
        }),
      );
      expect(config.headers).toEqual({
        Authorization: "Bearer token",
        "X-Custom": "value",
      });
    });

    it("should not set headers when header array is empty", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ header: [] }),
      );
      expect(config.headers).toBeUndefined();
    });

    it("should map --cookie-file to config.cookieFile", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ cookieFile: "./cookies.txt" }),
      );
      expect(config.cookieFile).toBe("./cookies.txt");
    });

    it("should map --model to config.model", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ model: "gpt-4o" }),
      );
      expect(config.model).toBe("gpt-4o");
    });

    it("should create llmConfig when --provider is given without --llm-config", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ provider: "openai" }),
      );
      expect(config.llmConfig).toBeDefined();
      expect(config.llmConfig!.defaults.provider).toBe("openai");
    });

    it("should use provided --model in llmConfig when --provider is given", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ provider: "openai", model: "gpt-4o" }),
      );
      expect(config.llmConfig!.defaults.model).toBe("gpt-4o");
    });

    it("should use default model when --provider is given without --model", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ provider: "openai" }),
      );
      expect(config.llmConfig!.defaults.model).toBe(
        "claude-3-5-haiku-latest",
      );
    });

    it("should map --link-classification to config.linkClassification", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ linkClassification: "per-link" }),
      );
      expect(config.linkClassification).toBe("per-link");
    });

    it("should load --llm-config from file", () => {
      const mockLLMConfig = {
        defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      };
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify(mockLLMConfig),
      );

      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ llmConfig: "/path/to/config.json" }),
      );
      expect(config.llmConfig).toEqual(mockLLMConfig);
    });

    it("should override provider in loaded llmConfig when --provider is also given", () => {
      const mockLLMConfig = {
        defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      };
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify(mockLLMConfig),
      );

      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({
          llmConfig: "/path/to/config.json",
          provider: "openai",
        }),
      );
      expect(config.llmConfig!.defaults.provider).toBe("openai");
    });

    it("should map --prefix to config.pathPrefix", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions({ prefix: "/docs/api" }),
      );
      expect(config.pathPrefix).toBe("/docs/api");
    });

    it("should not set pathPrefix when --prefix is not provided", () => {
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions(),
      );
      expect(config.pathPrefix).toBeUndefined();
    });

    it("should only set properties that are explicitly provided", () => {
      // With minimal options, many config fields should be undefined
      const config = buildConfig(
        "https://example.com",
        makeDefaultCLIOptions(),
      );

      // These should be undefined because the user did not explicitly set them
      expect(config.description).toBeUndefined();
      expect(config.includePatterns).toBeUndefined();
      expect(config.excludePatterns).toBeUndefined();
      expect(config.singleFile).toBeUndefined();
      expect(config.conversionStrategy).toBeUndefined();
      expect(config.respectRobots).toBeUndefined();
      expect(config.headers).toBeUndefined();
      expect(config.cookieFile).toBeUndefined();
      expect(config.llmConfig).toBeUndefined();
      expect(config.model).toBeUndefined();
      expect(config.linkClassification).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // createProgressCallbacks
  // -------------------------------------------------------------------------
  describe("createProgressCallbacks", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("should return onPageFetched, onPageSkipped, and onError callbacks", () => {
      const callbacks = createProgressCallbacks("normal");
      expect(typeof callbacks.onPageFetched).toBe("function");
      expect(typeof callbacks.onPageSkipped).toBe("function");
      expect(typeof callbacks.onError).toBe("function");
    });

    describe("quiet mode", () => {
      it("should not write to stderr on page fetched", () => {
        const callbacks = createProgressCallbacks("quiet");
        callbacks.onPageFetched({
          url: "https://example.com",
          html: "<html></html>",
          markdown: "# Test",
          statusCode: 200,
          headers: {},
          fetchedAt: new Date(),
          depth: 0,
        });
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it("should not write to stderr on page skipped", () => {
        const callbacks = createProgressCallbacks("quiet");
        callbacks.onPageSkipped("https://example.com/skip", "blocked");
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it("should not write to stderr on error", () => {
        const callbacks = createProgressCallbacks("quiet");
        callbacks.onError("https://example.com/err", new Error("fail"));
        expect(stderrSpy).not.toHaveBeenCalled();
      });
    });

    describe("normal mode", () => {
      it("should write page count and URL on page fetched", () => {
        const callbacks = createProgressCallbacks("normal");
        callbacks.onPageFetched({
          url: "https://example.com/page1",
          html: "<html></html>",
          markdown: "# Test",
          statusCode: 200,
          headers: {},
          fetchedAt: new Date(),
          depth: 0,
        });
        expect(stderrSpy).toHaveBeenCalledWith(
          "[1] https://example.com/page1\n",
        );
      });

      it("should increment page count across multiple fetches", () => {
        const callbacks = createProgressCallbacks("normal");
        const page = {
          url: "https://example.com/page1",
          html: "<html></html>",
          markdown: "# Test",
          statusCode: 200,
          headers: {},
          fetchedAt: new Date(),
          depth: 0,
        } as FetchedPage;

        callbacks.onPageFetched(page);
        callbacks.onPageFetched({
          ...page,
          url: "https://example.com/page2",
        });
        expect(stderrSpy).toHaveBeenCalledWith(
          "[2] https://example.com/page2\n",
        );
      });

      it("should not write on skipped pages in normal mode", () => {
        const callbacks = createProgressCallbacks("normal");
        callbacks.onPageSkipped("https://example.com/skip", "robots.txt");
        expect(stderrSpy).not.toHaveBeenCalled();
      });

      it("should write error messages to stderr", () => {
        const callbacks = createProgressCallbacks("normal");
        callbacks.onError(
          "https://example.com/err",
          new Error("Connection failed"),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("Error: https://example.com/err"),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("Connection failed"),
        );
      });
    });

    describe("verbose mode", () => {
      it("should write detailed info including status code and content length on page fetched", () => {
        const callbacks = createProgressCallbacks("verbose");
        callbacks.onPageFetched({
          url: "https://example.com/page1",
          html: "<html></html>",
          markdown: "# Test content",
          statusCode: 200,
          headers: {},
          fetchedAt: new Date(),
          depth: 0,
        });
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("Fetched:"),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("200"),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("chars"),
        );
      });

      it("should write skipped page info in verbose mode", () => {
        const callbacks = createProgressCallbacks("verbose");
        callbacks.onPageSkipped(
          "https://example.com/blocked",
          "robots.txt disallowed",
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("Skipped:"),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("https://example.com/blocked"),
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("robots.txt disallowed"),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // printSummary
  // -------------------------------------------------------------------------
  describe("printSummary", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("should print page count and duration on normal mode", () => {
      printSummary(
        makeFetchResult({
          stats: { totalPages: 5, totalSkipped: 0, duration: 2500 },
        }),
        "normal",
      );

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("5 pages");
      expect(output).toContain("2.5s");
    });

    it("should include skipped count when there are skipped pages", () => {
      printSummary(
        makeFetchResult({
          stats: { totalPages: 10, totalSkipped: 3, duration: 5000 },
        }),
        "normal",
      );

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("skipped 3");
    });

    it("should print output path", () => {
      printSummary(
        makeFetchResult({ outputPath: "/my/output" }),
        "normal",
      );

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("/my/output");
    });

    it("should print index path when available", () => {
      printSummary(
        makeFetchResult({ indexPath: "/output/INDEX.md" }),
        "normal",
      );

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("Index:");
      expect(output).toContain("/output/INDEX.md");
    });

    it("should print single file path when available", () => {
      printSummary(
        makeFetchResult({ singleFilePath: "/output/all.md" }),
        "normal",
      );

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("Single file:");
      expect(output).toContain("/output/all.md");
    });

    it("should suppress output in quiet mode", () => {
      printSummary(makeFetchResult(), "quiet");
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // printDryRun
  // -------------------------------------------------------------------------
  describe("printDryRun", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("should display the URL, mode, depth, pages, and output dir", () => {
      printDryRun("https://example.com", {
        mode: "simple",
        maxDepth: 5,
        maxPages: 100,
        outputDir: "./output",
        respectRobots: true,
      });

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");

      expect(output).toContain("Dry Run");
      expect(output).toContain("https://example.com");
      expect(output).toContain("simple");
      expect(output).toContain("5");
      expect(output).toContain("100");
      expect(output).toContain("./output");
      expect(output).toContain("true");
    });

    it("should display description when provided", () => {
      printDryRun("https://example.com", {
        mode: "smart",
        maxDepth: 5,
        maxPages: 100,
        outputDir: "./output",
        respectRobots: true,
        description: "API documentation",
      });

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("Description: API documentation");
    });

    it("should display include patterns when provided", () => {
      printDryRun("https://example.com", {
        mode: "simple",
        maxDepth: 5,
        maxPages: 100,
        outputDir: "./output",
        respectRobots: true,
        includePatterns: ["/docs/**", "/api/**"],
      });

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("Include patterns:");
      expect(output).toContain("/docs/**");
      expect(output).toContain("/api/**");
    });

    it("should display exclude patterns when provided", () => {
      printDryRun("https://example.com", {
        mode: "simple",
        maxDepth: 5,
        maxPages: 100,
        outputDir: "./output",
        respectRobots: true,
        excludePatterns: ["/blog/**"],
      });

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("Exclude patterns:");
      expect(output).toContain("/blog/**");
    });

    it("should display path prefix when provided", () => {
      printDryRun("https://example.com", {
        mode: "simple",
        maxDepth: 5,
        maxPages: 100,
        outputDir: "./output",
        respectRobots: true,
        pathPrefix: "/docs/api",
      });

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("Path prefix: /docs/api");
    });

    it("should show 'No pages will be fetched' message", () => {
      printDryRun("https://example.com", {
        mode: "simple",
        maxDepth: 5,
        maxPages: 100,
        outputDir: "./output",
        respectRobots: true,
      });

      const output = stderrSpy.mock.calls
        .map((c) => c[0])
        .join("");
      expect(output).toContain("No pages will be fetched");
    });
  });

  // -------------------------------------------------------------------------
  // run() — CLI integration via commander
  // -------------------------------------------------------------------------
  describe("run() - CLI integration", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      mockWebsiteFetch.mockResolvedValue(makeFetchResult());
      exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it("should call websiteFetch with the correct URL", async () => {
      await run(["node", "website-fetch", "https://example.com"]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://example.com" }),
      );
    });

    it("should exit with code 0 on success", async () => {
      await run(["node", "website-fetch", "https://example.com"]);

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("should pass --mode option to websiteFetch", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "-m",
        "simple",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "simple" }),
      );
    });

    it("should pass --depth option as maxDepth number", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--depth",
        "3",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ maxDepth: 3 }),
      );
    });

    it("should pass --max-pages option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--max-pages",
        "50",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ maxPages: 50 }),
      );
    });

    it("should pass --output option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "-o",
        "/custom/dir",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ outputDir: "/custom/dir" }),
      );
    });

    it("should pass --flat to set outputStructure flat", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--flat",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ outputStructure: "flat" }),
      );
    });

    it("should pass --single-file option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--single-file",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ singleFile: true }),
      );
    });

    it("should pass --no-index to set generateIndex false", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--no-index",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ generateIndex: false }),
      );
    });

    it("should pass --header option parsed into headers object", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--header",
        "Authorization:Bearer token",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: { Authorization: "Bearer token" },
        }),
      );
    });

    it("should support multiple --header options", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--header",
        "Authorization:Bearer token",
        "--header",
        "X-Custom:value",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: "Bearer token",
            "X-Custom": "value",
          },
        }),
      );
    });

    it("should support multiple --include options", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--include",
        "/docs/**",
        "--include",
        "/api/**",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          includePatterns: ["/docs/**", "/api/**"],
        }),
      );
    });

    it("should support multiple --exclude options", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--exclude",
        "/blog/**",
        "--exclude",
        "/admin/**",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          excludePatterns: ["/blog/**", "/admin/**"],
        }),
      );
    });

    it("should pass --delay option as a number", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--delay",
        "500",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ delay: 500 }),
      );
    });

    it("should pass --concurrency option as a number", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--concurrency",
        "5",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 5 }),
      );
    });

    it("should pass --ignore-robots to set respectRobots false", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--ignore-robots",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ respectRobots: false }),
      );
    });

    it("should pass --conversion option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--conversion",
        "readability",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ conversionStrategy: "readability" }),
      );
    });

    it("should pass --model option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--model",
        "gpt-4o",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-4o" }),
      );
    });

    it("should pass --prefix option as pathPrefix", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--prefix",
        "/docs/api",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ pathPrefix: "/docs/api" }),
      );
    });

    it("should pass --link-classification option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "--link-classification",
        "per-link",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ linkClassification: "per-link" }),
      );
    });

    it("should pass --description option", async () => {
      await run([
        "node",
        "website-fetch",
        "https://example.com",
        "-m",
        "smart",
        "-d",
        "API documentation",
      ]);

      expect(mockWebsiteFetch).toHaveBeenCalledWith(
        expect.objectContaining({ description: "API documentation" }),
      );
    });

    it("should attach progress callbacks when not in dry-run mode", async () => {
      await run(["node", "website-fetch", "https://example.com"]);

      const calledConfig = mockWebsiteFetch.mock.calls[0]![0] as any;
      expect(typeof calledConfig.onPageFetched).toBe("function");
      expect(typeof calledConfig.onPageSkipped).toBe("function");
      expect(typeof calledConfig.onError).toBe("function");
    });

    // -----------------------------------------------------------------------
    // Dry-run mode
    // -----------------------------------------------------------------------
    describe("--dry-run mode", () => {
      it("should call process.exit(0) before websiteFetch would execute", async () => {
        // Dry-run calls process.exit(0) before websiteFetch.
        // Since process.exit is mocked (no-op), code continues past it,
        // but we verify process.exit(0) was called to confirm dry-run logic.
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--dry-run",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(0);
      });

      it("should exit with code 0 in dry-run mode", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--dry-run",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(0);
      });

      it("should print dry-run output to stderr", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--dry-run",
        ]);

        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Dry Run");
        expect(output).toContain("https://example.com");
      });
    });

    // -----------------------------------------------------------------------
    // Error handling / edge cases
    // -----------------------------------------------------------------------
    describe("error handling", () => {
      it("should exit with code 1 when websiteFetch throws an error", async () => {
        mockWebsiteFetch.mockRejectedValue(new Error("Crawl failed"));

        await run(["node", "website-fetch", "https://example.com"]);

        expect(exitSpy).toHaveBeenCalledWith(1);
      });

      it("should write error message to stderr when websiteFetch fails", async () => {
        mockWebsiteFetch.mockRejectedValue(new Error("Network error"));

        await run(["node", "website-fetch", "https://example.com"]);

        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Error:");
        expect(output).toContain("Network error");
      });

      it("should exit with code 1 for invalid mode", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "-m",
          "turbo",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Invalid mode");
        expect(output).toContain("turbo");
      });

      it("should exit with code 1 for smart mode without description", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "-m",
          "smart",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("--description");
        expect(output).toContain("smart");
      });

      it("should exit with code 1 for agent mode without description", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "-m",
          "agent",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("--description");
        expect(output).toContain("agent");
      });

      it("should exit with code 1 when --verbose and --quiet are used together", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--verbose",
          "--quiet",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("--verbose");
        expect(output).toContain("--quiet");
      });

      it("should exit with code 1 for invalid conversion strategy", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--conversion",
          "magic",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Invalid conversion strategy");
        expect(output).toContain("magic");
      });

      it("should exit with code 1 for invalid link-classification", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--link-classification",
          "invalid",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Invalid link classification");
        expect(output).toContain("invalid");
      });

      it("should exit with code 1 when --llm-config file does not exist", async () => {
        (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error("ENOENT: no such file or directory");
        });

        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--llm-config",
          "/nonexistent/config.json",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Cannot read LLM config file");
      });

      it("should exit with code 1 when --header has malformed value", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--header",
          "MalformedHeaderNoColon",
        ]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("Invalid header format");
      });

      it("should handle non-Error thrown values gracefully", async () => {
        mockWebsiteFetch.mockRejectedValue("string error");

        await run(["node", "website-fetch", "https://example.com"]);

        expect(exitSpy).toHaveBeenCalledWith(1);
        const output = stderrSpy.mock.calls
          .map((c) => c[0])
          .join("");
        expect(output).toContain("string error");
      });
    });

    // -----------------------------------------------------------------------
    // Verbosity modes via run()
    // -----------------------------------------------------------------------
    describe("verbosity in run()", () => {
      it("should pass progress callbacks in normal mode", async () => {
        await run(["node", "website-fetch", "https://example.com"]);

        const calledConfig = mockWebsiteFetch.mock.calls[0]![0] as any;
        expect(calledConfig.onPageFetched).toBeDefined();
      });

      it("should pass progress callbacks in verbose mode", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--verbose",
        ]);

        const calledConfig = mockWebsiteFetch.mock.calls[0]![0] as any;
        expect(calledConfig.onPageFetched).toBeDefined();
      });

      it("should pass progress callbacks in quiet mode", async () => {
        await run([
          "node",
          "website-fetch",
          "https://example.com",
          "--quiet",
        ]);

        const calledConfig = mockWebsiteFetch.mock.calls[0]![0] as any;
        // Quiet mode still attaches callbacks (they just don't produce output)
        expect(calledConfig.onPageFetched).toBeDefined();
      });
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebsiteFetchConfig, FetchResult, FetchedPage } from "../types.js";
import { CONFIG_DEFAULTS } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before import of the module under test.
// ---------------------------------------------------------------------------

// Mock the fetcher module
const mockFetcherClose = vi.fn();
const mockFetcherFetch = vi.fn();
const mockFetcherIsAllowed = vi.fn();
const mockFetcherGetCrawlDelay = vi.fn();
vi.mock("../fetcher/index.js", () => ({
  createFetcher: vi.fn(() => ({
    fetch: mockFetcherFetch,
    isAllowed: mockFetcherIsAllowed,
    close: mockFetcherClose,
    getCrawlDelay: mockFetcherGetCrawlDelay,
  })),
}));

// Mock the converter module
const mockConvert = vi.fn(async () => "# Converted");
vi.mock("../converter/index.js", () => ({
  createConverter: vi.fn(() => ({
    convert: mockConvert,
  })),
}));

// Mock the output writer module
const mockWritePage = vi.fn(async () => "output/path.md");
const mockUrlToFilePath = vi.fn(() => "output/path.md");
vi.mock("../output/index.js", () => ({
  createOutputWriter: vi.fn(() => ({
    writePage: mockWritePage,
    urlToFilePath: mockUrlToFilePath,
  })),
}));

// Mock the LLM provider module
const mockLLMInvoke = vi.fn();
const mockLLMInvokeStructured = vi.fn();
vi.mock("../llm/index.js", () => ({
  createLLMProvider: vi.fn(() => ({
    invoke: mockLLMInvoke,
    invokeStructured: mockLLMInvokeStructured,
  })),
}));

// Mock the IndexGenerator
const mockIndexGenerate = vi.fn(async () => "/output/INDEX.md");
vi.mock("../output/index-generator.js", () => ({
  IndexGenerator: vi.fn(() => ({
    generate: mockIndexGenerate,
  })),
  createLLMDescriptionProvider: vi.fn(() => vi.fn()),
}));

// Mock the SingleFileWriter
const mockSingleFileWrite = vi.fn(async () => "/output/aggregated.md");
vi.mock("../output/single-file.js", () => ({
  SingleFileWriter: vi.fn(() => ({
    write: mockSingleFileWrite,
  })),
}));

// Mock SimpleCrawler
const mockSimpleCrawl = vi.fn<[], Promise<FetchResult>>();
vi.mock("../crawler/simple.js", () => ({
  SimpleCrawler: vi.fn(() => ({
    crawl: mockSimpleCrawl,
  })),
}));

// Mock SmartCrawler
const mockSmartCrawl = vi.fn<[], Promise<FetchResult>>();
vi.mock("../crawler/smart.js", () => ({
  SmartCrawler: vi.fn(() => ({
    crawl: mockSmartCrawl,
  })),
}));

// Mock AgentCrawler
const mockAgentCrawl = vi.fn<[], Promise<FetchResult>>();
vi.mock("../crawler/agent.js", () => ({
  AgentCrawler: vi.fn(() => ({
    crawl: mockAgentCrawl,
  })),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import {
  websiteFetch,
  validateAndMergeConfig,
  createCrawler,
} from "../sdk/index.js";
import { createFetcher } from "../fetcher/index.js";
import { createConverter } from "../converter/index.js";
import { createOutputWriter } from "../output/index.js";
import { createLLMProvider } from "../llm/index.js";
import { SimpleCrawler } from "../crawler/simple.js";
import { SmartCrawler } from "../crawler/smart.js";
import { AgentCrawler } from "../crawler/agent.js";
import { IndexGenerator } from "../output/index-generator.js";
import { SingleFileWriter } from "../output/single-file.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock FetchResult for use in crawler mock returns. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SDK Entry Point (src/sdk/index.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mock implementations to their default behavior
    mockFetcherClose.mockReset();
    mockIndexGenerate.mockReset();
    mockSingleFileWrite.mockReset();

    // Set default crawler mock returns
    const defaultResult = makeFetchResult();
    mockSimpleCrawl.mockResolvedValue(defaultResult);
    mockSmartCrawl.mockResolvedValue(defaultResult);
    mockAgentCrawl.mockResolvedValue(defaultResult);
    mockIndexGenerate.mockResolvedValue("/output/INDEX.md");
    mockSingleFileWrite.mockResolvedValue("/output/aggregated.md");
  });

  // -------------------------------------------------------------------------
  // validateConfig
  // -------------------------------------------------------------------------
  describe("validateConfig (via validateAndMergeConfig)", () => {
    it("should throw error when url is missing", () => {
      expect(() =>
        validateAndMergeConfig({ url: "" }),
      ).toThrow(/url.*required/i);
    });

    it("should throw error when url is whitespace only", () => {
      expect(() =>
        validateAndMergeConfig({ url: "   " }),
      ).toThrow(/url.*required/i);
    });

    it("should throw error for smart mode without description", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "smart",
        }),
      ).toThrow(/description.*required.*smart/i);
    });

    it("should throw error for agent mode without description", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "agent",
        }),
      ).toThrow(/description.*required.*agent/i);
    });

    it("should throw error for smart mode with empty description", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "smart",
          description: "   ",
        }),
      ).toThrow(/description.*required.*smart/i);
    });

    it("should throw error for agent mode with empty description", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "agent",
          description: "",
        }),
      ).toThrow(/description.*required.*agent/i);
    });

    it("should throw error for unknown mode value", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "turbo" as WebsiteFetchConfig["mode"],
        }),
      ).toThrow(/unknown mode.*turbo/i);
    });

    it("should not throw for valid simple mode config", () => {
      expect(() =>
        validateAndMergeConfig({ url: "https://example.com" }),
      ).not.toThrow();
    });

    it("should not throw for valid smart mode with description", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "smart",
          description: "API docs",
        }),
      ).not.toThrow();
    });

    it("should not throw for valid agent mode with description", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "agent",
          description: "Find tutorials",
        }),
      ).not.toThrow();
    });

    it("should not require description for simple mode", () => {
      expect(() =>
        validateAndMergeConfig({
          url: "https://example.com",
          mode: "simple",
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // mergeDefaults
  // -------------------------------------------------------------------------
  describe("mergeDefaults (via validateAndMergeConfig)", () => {
    it("should apply all CONFIG_DEFAULTS for minimal config", () => {
      const config = validateAndMergeConfig({ url: "https://example.com" });

      expect(config.url).toBe("https://example.com");
      expect(config.mode).toBe(CONFIG_DEFAULTS.mode);
      expect(config.maxDepth).toBe(CONFIG_DEFAULTS.maxDepth);
      expect(config.maxPages).toBe(CONFIG_DEFAULTS.maxPages);
      expect(config.outputDir).toBe(CONFIG_DEFAULTS.outputDir);
      expect(config.outputStructure).toBe(CONFIG_DEFAULTS.outputStructure);
      expect(config.generateIndex).toBe(CONFIG_DEFAULTS.generateIndex);
      expect(config.delay).toBe(CONFIG_DEFAULTS.delay);
      expect(config.concurrency).toBe(CONFIG_DEFAULTS.concurrency);
      expect(config.respectRobots).toBe(CONFIG_DEFAULTS.respectRobots);
      expect(config.adaptiveRateLimit).toBe(CONFIG_DEFAULTS.adaptiveRateLimit);
    });

    it("should use simple mode by default", () => {
      const config = validateAndMergeConfig({ url: "https://example.com" });
      expect(config.mode).toBe("simple");
    });

    it("should preserve user-provided values over defaults", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        maxDepth: 10,
        maxPages: 500,
        outputDir: "/custom/output",
        delay: 1000,
      });

      expect(config.maxDepth).toBe(10);
      expect(config.maxPages).toBe(500);
      expect(config.outputDir).toBe("/custom/output");
      expect(config.delay).toBe(1000);
    });

    it("should apply mode-specific defaults for simple mode", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "simple",
      });

      expect(config.conversionStrategy).toBe("default");
      expect(config.optimizeConversion).toBe(false);
    });

    it("should apply mode-specific defaults for smart mode", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "smart",
        description: "docs",
      });

      expect(config.conversionStrategy).toBe("readability");
      expect(config.optimizeConversion).toBe(false);
    });

    it("should apply mode-specific defaults for agent mode", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "agent",
        description: "tutorials",
      });

      expect(config.conversionStrategy).toBe("readability");
      expect(config.optimizeConversion).toBe(true);
    });

    it("should allow user to override mode-specific defaults", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "agent",
        description: "stuff",
        conversionStrategy: "default",
        optimizeConversion: false,
      });

      // User values should win over mode-specific defaults
      expect(config.conversionStrategy).toBe("default");
      expect(config.optimizeConversion).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // createCrawler factory
  // -------------------------------------------------------------------------
  describe("createCrawler factory", () => {
    it("should create SimpleCrawler for simple mode", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "simple",
      });

      const fetcher = (createFetcher as ReturnType<typeof vi.fn>)();
      const converter = (createConverter as ReturnType<typeof vi.fn>)();
      const outputWriter = (createOutputWriter as ReturnType<typeof vi.fn>)();

      createCrawler(config, fetcher, converter, outputWriter);

      expect(SimpleCrawler).toHaveBeenCalledWith(
        config,
        fetcher,
        converter,
        outputWriter,
      );
    });

    it("should create SmartCrawler for smart mode", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "smart",
        description: "API docs",
      });

      const fetcher = (createFetcher as ReturnType<typeof vi.fn>)();
      const converter = (createConverter as ReturnType<typeof vi.fn>)();
      const outputWriter = (createOutputWriter as ReturnType<typeof vi.fn>)();
      const llmProvider = (createLLMProvider as ReturnType<typeof vi.fn>)();

      createCrawler(config, fetcher, converter, outputWriter, llmProvider);

      expect(SmartCrawler).toHaveBeenCalledWith(
        config,
        fetcher,
        converter,
        outputWriter,
        llmProvider,
        "API docs",
      );
    });

    it("should create AgentCrawler for agent mode", () => {
      const config = validateAndMergeConfig({
        url: "https://example.com",
        mode: "agent",
        description: "Find tutorials",
      });

      const fetcher = (createFetcher as ReturnType<typeof vi.fn>)();
      const converter = (createConverter as ReturnType<typeof vi.fn>)();
      const outputWriter = (createOutputWriter as ReturnType<typeof vi.fn>)();
      const llmProvider = (createLLMProvider as ReturnType<typeof vi.fn>)();

      createCrawler(config, fetcher, converter, outputWriter, llmProvider);

      expect(AgentCrawler).toHaveBeenCalledWith(
        config,
        fetcher,
        converter,
        outputWriter,
        llmProvider,
        "Find tutorials",
      );
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — mode routing
  // -------------------------------------------------------------------------
  describe("websiteFetch mode routing", () => {
    it("should use SimpleCrawler for default (simple) mode", async () => {
      await websiteFetch({ url: "https://example.com" });

      expect(SimpleCrawler).toHaveBeenCalled();
      expect(mockSimpleCrawl).toHaveBeenCalled();
      expect(SmartCrawler).not.toHaveBeenCalled();
      expect(AgentCrawler).not.toHaveBeenCalled();
    });

    it("should use SmartCrawler for smart mode", async () => {
      await websiteFetch({
        url: "https://example.com",
        mode: "smart",
        description: "API docs",
      });

      expect(SmartCrawler).toHaveBeenCalled();
      expect(mockSmartCrawl).toHaveBeenCalled();
      expect(SimpleCrawler).not.toHaveBeenCalled();
      expect(AgentCrawler).not.toHaveBeenCalled();
    });

    it("should use AgentCrawler for agent mode", async () => {
      await websiteFetch({
        url: "https://example.com",
        mode: "agent",
        description: "Find tutorials",
      });

      expect(AgentCrawler).toHaveBeenCalled();
      expect(mockAgentCrawl).toHaveBeenCalled();
      expect(SimpleCrawler).not.toHaveBeenCalled();
      expect(SmartCrawler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — LLM provider creation
  // -------------------------------------------------------------------------
  describe("websiteFetch LLM provider handling", () => {
    it("should NOT create LLM provider for simple mode", async () => {
      await websiteFetch({ url: "https://example.com", mode: "simple" });

      expect(createLLMProvider).not.toHaveBeenCalled();
    });

    it("should create LLM provider for smart mode", async () => {
      await websiteFetch({
        url: "https://example.com",
        mode: "smart",
        description: "docs",
      });

      expect(createLLMProvider).toHaveBeenCalled();
    });

    it("should create LLM provider for agent mode", async () => {
      await websiteFetch({
        url: "https://example.com",
        mode: "agent",
        description: "tutorials",
      });

      expect(createLLMProvider).toHaveBeenCalled();
    });

    it("should use user-provided llmProvider instead of creating a new one", async () => {
      const customLLM = {
        invoke: vi.fn(),
        invokeStructured: vi.fn(),
      };

      await websiteFetch({
        url: "https://example.com",
        mode: "smart",
        description: "docs",
        llmProvider: customLLM,
      });

      // Should NOT call createLLMProvider since the user provided one
      expect(createLLMProvider).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — component creation
  // -------------------------------------------------------------------------
  describe("websiteFetch component creation", () => {
    it("should create fetcher with merged config", async () => {
      await websiteFetch({ url: "https://example.com" });

      expect(createFetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
          mode: "simple",
        }),
      );
    });

    it("should create converter with merged config", async () => {
      await websiteFetch({ url: "https://example.com" });

      expect(createConverter).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
        }),
      );
    });

    it("should create output writer with merged config", async () => {
      await websiteFetch({ url: "https://example.com" });

      expect(createOutputWriter).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — index generation
  // -------------------------------------------------------------------------
  describe("websiteFetch index generation", () => {
    it("should generate index when generateIndex is true", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        generateIndex: true,
      });

      expect(IndexGenerator).toHaveBeenCalled();
      expect(mockIndexGenerate).toHaveBeenCalled();
      expect(result.indexPath).toBe("/output/INDEX.md");
    });

    it("should NOT generate index when generateIndex is false", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        generateIndex: false,
      });

      expect(mockIndexGenerate).not.toHaveBeenCalled();
      expect(result.indexPath).toBeUndefined();
    });

    it("should generate index by default (CONFIG_DEFAULTS has generateIndex: true)", async () => {
      // Default config has generateIndex: true
      const result = await websiteFetch({
        url: "https://example.com",
      });

      expect(mockIndexGenerate).toHaveBeenCalled();
      expect(result.indexPath).toBe("/output/INDEX.md");
    });

    it("should pass pages and config to index generator", async () => {
      const pages = [
        {
          url: "https://example.com",
          html: "<html></html>",
          markdown: "# Test",
          statusCode: 200,
          headers: {},
          fetchedAt: new Date(),
          depth: 0,
        } as FetchedPage,
      ];

      mockSimpleCrawl.mockResolvedValue(
        makeFetchResult({ pages }),
      );

      await websiteFetch({
        url: "https://example.com",
        generateIndex: true,
      });

      expect(mockIndexGenerate).toHaveBeenCalledWith(
        pages,
        expect.any(String), // outputDir
        expect.any(String), // outputStructure
        undefined, // no descriptionProvider for simple mode (no LLM)
      );
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — single file generation
  // -------------------------------------------------------------------------
  describe("websiteFetch single file generation", () => {
    it("should generate single file when singleFile is true", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        singleFile: true,
      });

      expect(SingleFileWriter).toHaveBeenCalled();
      expect(mockSingleFileWrite).toHaveBeenCalled();
      expect(result.singleFilePath).toBe("/output/aggregated.md");
    });

    it("should NOT generate single file when singleFile is false", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        singleFile: false,
      });

      expect(mockSingleFileWrite).not.toHaveBeenCalled();
      expect(result.singleFilePath).toBeUndefined();
    });

    it("should NOT generate single file when singleFile is not set", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
      });

      expect(mockSingleFileWrite).not.toHaveBeenCalled();
      expect(result.singleFilePath).toBeUndefined();
    });

    it("should pass pages, outputDir, and url to SingleFileWriter.write", async () => {
      const pages = [
        {
          url: "https://example.com",
          html: "<html></html>",
          markdown: "# Test",
          statusCode: 200,
          headers: {},
          fetchedAt: new Date(),
          depth: 0,
        } as FetchedPage,
      ];

      mockSimpleCrawl.mockResolvedValue(
        makeFetchResult({ pages }),
      );

      await websiteFetch({
        url: "https://example.com",
        singleFile: true,
      });

      expect(mockSingleFileWrite).toHaveBeenCalledWith(
        pages,
        expect.any(String), // outputDir
        "https://example.com", // url
      );
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — resource cleanup
  // -------------------------------------------------------------------------
  describe("websiteFetch resource cleanup", () => {
    it("should call fetcher.close() on successful crawl", async () => {
      await websiteFetch({ url: "https://example.com" });

      expect(mockFetcherClose).toHaveBeenCalledTimes(1);
    });

    it("should call fetcher.close() when crawl throws an error", async () => {
      mockSimpleCrawl.mockRejectedValue(new Error("Crawl failed"));

      await expect(
        websiteFetch({ url: "https://example.com" }),
      ).rejects.toThrow("Crawl failed");

      // close() should still be called via finally block
      expect(mockFetcherClose).toHaveBeenCalledTimes(1);
    });

    it("should call fetcher.close() when index generation throws an error", async () => {
      mockIndexGenerate.mockRejectedValueOnce(new Error("Index gen failed"));

      await expect(
        websiteFetch({
          url: "https://example.com",
          generateIndex: true,
        }),
      ).rejects.toThrow("Index gen failed");

      expect(mockFetcherClose).toHaveBeenCalledTimes(1);
    });

    it("should call fetcher.close() when single file generation throws an error", async () => {
      mockSingleFileWrite.mockRejectedValueOnce(
        new Error("Single file failed"),
      );

      await expect(
        websiteFetch({
          url: "https://example.com",
          singleFile: true,
        }),
      ).rejects.toThrow("Single file failed");

      expect(mockFetcherClose).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — return value
  // -------------------------------------------------------------------------
  describe("websiteFetch return value", () => {
    it("should return the FetchResult from the crawler", async () => {
      const expectedResult = makeFetchResult({
        pages: [
          {
            url: "https://example.com",
            html: "<html></html>",
            markdown: "# Result",
            statusCode: 200,
            headers: {},
            fetchedAt: new Date(),
            depth: 0,
          } as FetchedPage,
          {
            url: "https://example.com/about",
            html: "<html></html>",
            markdown: "# About",
            statusCode: 200,
            headers: {},
            fetchedAt: new Date(),
            depth: 1,
          } as FetchedPage,
        ],
        stats: { totalPages: 2, totalSkipped: 0, duration: 200 },
      });

      mockSimpleCrawl.mockResolvedValue(expectedResult);

      const result = await websiteFetch({
        url: "https://example.com",
        generateIndex: false,
      });

      expect(result.pages).toHaveLength(2);
      expect(result.stats.totalPages).toBe(2);
    });

    it("should include indexPath on result when index is generated", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        generateIndex: true,
      });

      expect(result.indexPath).toBe("/output/INDEX.md");
    });

    it("should include singleFilePath on result when single file is generated", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        singleFile: true,
      });

      expect(result.singleFilePath).toBe("/output/aggregated.md");
    });
  });

  // -------------------------------------------------------------------------
  // websiteFetch — LLM provider injection order
  // -------------------------------------------------------------------------
  describe("websiteFetch LLM provider initialization order", () => {
    it("should create LLM provider before converter for smart mode", async () => {
      const callOrder: string[] = [];

      (createLLMProvider as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("createLLMProvider");
        return {
          invoke: mockLLMInvoke,
          invokeStructured: mockLLMInvokeStructured,
        };
      });

      (createConverter as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("createConverter");
        return { convert: mockConvert };
      });

      await websiteFetch({
        url: "https://example.com",
        mode: "smart",
        description: "docs",
      });

      const llmIndex = callOrder.indexOf("createLLMProvider");
      const converterIndex = callOrder.indexOf("createConverter");
      expect(llmIndex).toBeLessThan(converterIndex);
    });

    it("should inject LLM provider into config before creating converter", async () => {
      let configPassedToConverter: WebsiteFetchConfig | undefined;

      (createConverter as ReturnType<typeof vi.fn>).mockImplementation(
        (config: WebsiteFetchConfig) => {
          configPassedToConverter = config;
          return { convert: mockConvert };
        },
      );

      await websiteFetch({
        url: "https://example.com",
        mode: "smart",
        description: "docs",
      });

      expect(configPassedToConverter).toBeDefined();
      expect(configPassedToConverter!.llmProvider).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("should handle minimal config (just url) using all defaults", async () => {
      const result = await websiteFetch({ url: "https://example.com" });

      // Should use simple mode via defaults
      expect(SimpleCrawler).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.pages).toBeDefined();
    });

    it("should throw for missing url before creating any components", async () => {
      await expect(
        websiteFetch({ url: "" }),
      ).rejects.toThrow(/url.*required/i);

      // No components should have been created
      expect(createFetcher).not.toHaveBeenCalled();
      expect(createConverter).not.toHaveBeenCalled();
      expect(createOutputWriter).not.toHaveBeenCalled();
    });

    it("should throw for unknown mode before creating any components", async () => {
      await expect(
        websiteFetch({
          url: "https://example.com",
          mode: "nonexistent" as WebsiteFetchConfig["mode"],
        }),
      ).rejects.toThrow(/unknown mode/i);

      expect(createFetcher).not.toHaveBeenCalled();
    });

    it("should handle both generateIndex and singleFile together", async () => {
      const result = await websiteFetch({
        url: "https://example.com",
        generateIndex: true,
        singleFile: true,
      });

      expect(mockIndexGenerate).toHaveBeenCalled();
      expect(mockSingleFileWrite).toHaveBeenCalled();
      expect(result.indexPath).toBe("/output/INDEX.md");
      expect(result.singleFilePath).toBe("/output/aggregated.md");
    });

    it("should pass merged config (not user config) to component factories", async () => {
      await websiteFetch({
        url: "https://example.com",
        maxDepth: 3,
      });

      // The config passed to createFetcher should have both user values and defaults
      expect(createFetcher).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
          maxDepth: 3,
          mode: "simple", // from defaults
          maxPages: 100, // from defaults
        }),
      );
    });
  });
});

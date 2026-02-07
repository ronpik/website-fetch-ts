import { describe, it, expect } from "vitest";

// Import all shared types and the CONFIG_DEFAULTS value
import type {
  FetchedPageRaw,
  FetchedPage,
  SkippedPage,
  WebsiteFetchConfig,
  FetchResult,
} from "../types.js";
import { CONFIG_DEFAULTS } from "../types.js";

// Import all LLM-specific types
import type {
  LLMProvider,
  LLMConfig,
  LLMCallSiteConfig,
  LLMCallSiteKey,
  InvokeOptions,
} from "../llm/types.js";

// ----------------------------------------------------------------
// Type-level assignability helpers.
// These functions are never called at runtime; they only need to
// compile. If the types are wrong, `tsc` (or vitest type-checking)
// will catch it at compile time.
// ----------------------------------------------------------------

/**
 * Compile-time check: a minimal WebsiteFetchConfig (only required +
 * defaulted fields) must be assignable to the full interface.
 */
function _assertMinimalWebsiteFetchConfig(): WebsiteFetchConfig {
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
  };
}

/**
 * Compile-time check: FetchedPage extends FetchedPageRaw -- an object
 * satisfying FetchedPage must also satisfy FetchedPageRaw.
 */
function _assertFetchedPageExtendsRaw(): FetchedPageRaw {
  const page: FetchedPage = {
    url: "https://example.com",
    html: "<h1>Hi</h1>",
    statusCode: 200,
    headers: {},
    fetchedAt: new Date(),
    markdown: "# Hi",
    depth: 0,
  };
  // If FetchedPage extends FetchedPageRaw, this assignment is valid:
  const raw: FetchedPageRaw = page;
  return raw;
}

/**
 * Compile-time check: LLMConfig works with only defaults (no callSites).
 */
function _assertLLMConfigDefaultsOnly(): LLMConfig {
  return {
    defaults: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    },
  };
}

/**
 * Compile-time check: LLMConfig works with callSites specified.
 */
function _assertLLMConfigWithCallSites(): LLMConfig {
  return {
    defaults: {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      temperature: 0.7,
      maxTokens: 4096,
      timeout: 30000,
      maxRetries: 3,
    },
    callSites: {
      "link-classifier": { model: "gpt-4o-mini", temperature: 0 },
      "page-summarizer": { maxTokens: 2048 },
    },
  };
}

// Suppress "declared but never read" for the compile-time helpers
void _assertMinimalWebsiteFetchConfig;
void _assertFetchedPageExtendsRaw;
void _assertLLMConfigDefaultsOnly;
void _assertLLMConfigWithCallSites;

// ----------------------------------------------------------------
// Runtime tests
// ----------------------------------------------------------------

describe("shared types (src/types.ts)", () => {
  describe("type compilation", () => {
    it("should compile when all shared types are imported", () => {
      // The fact that this file compiles and runs means the type
      // imports above are all valid. We do a trivial assertion so
      // vitest counts this as a passing test.
      const _typeNames: string[] = [
        "FetchedPageRaw",
        "FetchedPage",
        "SkippedPage",
        "WebsiteFetchConfig",
        "FetchResult",
      ];
      expect(_typeNames).toHaveLength(5);
    });

    it("should compile when all LLM types are imported", () => {
      const _typeNames: string[] = [
        "LLMProvider",
        "LLMConfig",
        "LLMCallSiteConfig",
        "LLMCallSiteKey",
        "InvokeOptions",
      ];
      expect(_typeNames).toHaveLength(5);
    });
  });

  describe("CONFIG_DEFAULTS", () => {
    it("should be defined and be a non-null object", () => {
      expect(CONFIG_DEFAULTS).toBeDefined();
      expect(typeof CONFIG_DEFAULTS).toBe("object");
      expect(CONFIG_DEFAULTS).not.toBeNull();
    });

    it("should contain exactly 13 default keys", () => {
      const keys = Object.keys(CONFIG_DEFAULTS);
      expect(keys).toHaveLength(13);
    });

    it("should have mode defaulting to 'simple'", () => {
      expect(CONFIG_DEFAULTS.mode).toBe("simple");
    });

    it("should have maxDepth defaulting to 5", () => {
      expect(CONFIG_DEFAULTS.maxDepth).toBe(5);
    });

    it("should have maxPages defaulting to 100", () => {
      expect(CONFIG_DEFAULTS.maxPages).toBe(100);
    });

    it("should have outputDir defaulting to './output'", () => {
      expect(CONFIG_DEFAULTS.outputDir).toBe("./output");
    });

    it("should have outputStructure defaulting to 'mirror'", () => {
      expect(CONFIG_DEFAULTS.outputStructure).toBe("mirror");
    });

    it("should have generateIndex defaulting to true", () => {
      expect(CONFIG_DEFAULTS.generateIndex).toBe(true);
    });

    it("should have conversionStrategy defaulting to 'default'", () => {
      expect(CONFIG_DEFAULTS.conversionStrategy).toBe("default");
    });

    it("should have optimizeConversion defaulting to false", () => {
      expect(CONFIG_DEFAULTS.optimizeConversion).toBe(false);
    });

    it("should have delay defaulting to 200", () => {
      expect(CONFIG_DEFAULTS.delay).toBe(200);
    });

    it("should have concurrency defaulting to 3", () => {
      expect(CONFIG_DEFAULTS.concurrency).toBe(3);
    });

    it("should have respectRobots defaulting to true", () => {
      expect(CONFIG_DEFAULTS.respectRobots).toBe(true);
    });

    it("should have adaptiveRateLimit defaulting to true", () => {
      expect(CONFIG_DEFAULTS.adaptiveRateLimit).toBe(true);
    });

    it("should have linkClassification defaulting to 'batch'", () => {
      expect(CONFIG_DEFAULTS.linkClassification).toBe("batch");
    });

    it("should have all 13 documented default values with correct types", () => {
      // Comprehensive snapshot-style check of every default
      expect(CONFIG_DEFAULTS).toEqual({
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
        linkClassification: "batch",
      });
    });
  });

  describe("WebsiteFetchConfig", () => {
    it("should accept a minimal config with just url and required defaults", () => {
      // This verifies that the type allows all non-optional fields
      // to be provided, and that the shape is correct at runtime.
      const minimalConfig: WebsiteFetchConfig = {
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
      };

      expect(minimalConfig.url).toBe("https://example.com");
      expect(minimalConfig.mode).toBe("simple");
      // Optional fields should be undefined
      expect(minimalConfig.description).toBeUndefined();
      expect(minimalConfig.includePatterns).toBeUndefined();
      expect(minimalConfig.excludePatterns).toBeUndefined();
      expect(minimalConfig.singleFile).toBeUndefined();
      expect(minimalConfig.customConverter).toBeUndefined();
      expect(minimalConfig.headers).toBeUndefined();
      expect(minimalConfig.cookieFile).toBeUndefined();
      expect(minimalConfig.llmProvider).toBeUndefined();
      expect(minimalConfig.llmConfig).toBeUndefined();
      expect(minimalConfig.model).toBeUndefined();
      expect(minimalConfig.linkClassification).toBeUndefined();
      expect(minimalConfig.onPageFetched).toBeUndefined();
      expect(minimalConfig.onPageSkipped).toBeUndefined();
      expect(minimalConfig.onError).toBeUndefined();
    });

    it("should accept a full config with all optional fields", () => {
      const fullConfig: WebsiteFetchConfig = {
        url: "https://example.com",
        mode: "agent",
        description: "Fetch docs",
        maxDepth: 10,
        maxPages: 500,
        includePatterns: ["/docs/**"],
        excludePatterns: ["/blog/**"],
        outputDir: "./out",
        outputStructure: "flat",
        singleFile: true,
        generateIndex: false,
        conversionStrategy: "readability",
        optimizeConversion: true,
        customConverter: async (html: string, _url: string) => html,
        delay: 500,
        concurrency: 5,
        respectRobots: false,
        adaptiveRateLimit: false,
        headers: { Authorization: "Bearer token" },
        cookieFile: "./cookies.txt",
        linkClassification: "per-link",
        onPageFetched: (_page) => {},
        onPageSkipped: (_url, _reason) => {},
        onError: (_url, _error) => {},
      };

      expect(fullConfig.url).toBe("https://example.com");
      expect(fullConfig.mode).toBe("agent");
      expect(fullConfig.description).toBe("Fetch docs");
      expect(fullConfig.includePatterns).toEqual(["/docs/**"]);
      expect(fullConfig.excludePatterns).toEqual(["/blog/**"]);
      expect(fullConfig.singleFile).toBe(true);
      expect(fullConfig.headers).toEqual({ Authorization: "Bearer token" });
      expect(fullConfig.cookieFile).toBe("./cookies.txt");
      expect(fullConfig.linkClassification).toBe("per-link");
      expect(typeof fullConfig.customConverter).toBe("function");
      expect(typeof fullConfig.onPageFetched).toBe("function");
      expect(typeof fullConfig.onPageSkipped).toBe("function");
      expect(typeof fullConfig.onError).toBe("function");
    });

    it("should support all three mode values", () => {
      const modes: WebsiteFetchConfig["mode"][] = ["simple", "smart", "agent"];
      expect(modes).toHaveLength(3);
      expect(modes).toContain("simple");
      expect(modes).toContain("smart");
      expect(modes).toContain("agent");
    });

    it("should support both outputStructure values", () => {
      const structures: WebsiteFetchConfig["outputStructure"][] = [
        "mirror",
        "flat",
      ];
      expect(structures).toHaveLength(2);
    });

    it("should support all three conversionStrategy values", () => {
      const strategies: WebsiteFetchConfig["conversionStrategy"][] = [
        "default",
        "readability",
        "custom",
      ];
      expect(strategies).toHaveLength(3);
    });
  });

  describe("FetchedPageRaw", () => {
    it("should have the expected shape with all required fields", () => {
      const raw: FetchedPageRaw = {
        url: "https://example.com/page",
        html: "<html><body>Hello</body></html>",
        statusCode: 200,
        headers: { "content-type": "text/html" },
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
      };

      expect(raw.url).toBe("https://example.com/page");
      expect(raw.html).toContain("<html>");
      expect(raw.statusCode).toBe(200);
      expect(raw.headers["content-type"]).toBe("text/html");
      expect(raw.fetchedAt).toBeInstanceOf(Date);
    });
  });

  describe("FetchedPage", () => {
    it("should extend FetchedPageRaw with markdown, title, and depth", () => {
      const page: FetchedPage = {
        // FetchedPageRaw fields
        url: "https://example.com/page",
        html: "<html><body><h1>Title</h1></body></html>",
        statusCode: 200,
        headers: { "content-type": "text/html" },
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
        // FetchedPage additional fields
        markdown: "# Title",
        title: "Title",
        depth: 2,
      };

      // FetchedPageRaw fields are present
      expect(page.url).toBe("https://example.com/page");
      expect(page.html).toContain("<html>");
      expect(page.statusCode).toBe(200);
      expect(page.headers).toBeDefined();
      expect(page.fetchedAt).toBeInstanceOf(Date);

      // FetchedPage additional fields
      expect(page.markdown).toBe("# Title");
      expect(page.title).toBe("Title");
      expect(page.depth).toBe(2);
    });

    it("should allow title to be optional (undefined)", () => {
      const page: FetchedPage = {
        url: "https://example.com",
        html: "<html></html>",
        statusCode: 200,
        headers: {},
        fetchedAt: new Date(),
        markdown: "",
        depth: 0,
      };

      expect(page.title).toBeUndefined();
    });

    it("should be assignable to FetchedPageRaw (inheritance)", () => {
      const page: FetchedPage = {
        url: "https://example.com",
        html: "<p>test</p>",
        statusCode: 200,
        headers: {},
        fetchedAt: new Date(),
        markdown: "test",
        depth: 1,
      };

      // This assignment works because FetchedPage extends FetchedPageRaw
      const raw: FetchedPageRaw = page;
      expect(raw.url).toBe("https://example.com");
      expect(raw.statusCode).toBe(200);
    });
  });

  describe("SkippedPage", () => {
    it("should have url and reason fields", () => {
      const skipped: SkippedPage = {
        url: "https://example.com/blocked",
        reason: "robots.txt disallowed",
      };

      expect(skipped.url).toBe("https://example.com/blocked");
      expect(skipped.reason).toBe("robots.txt disallowed");
    });
  });

  describe("FetchResult", () => {
    it("should have all required fields with correct structure", () => {
      const result: FetchResult = {
        pages: [],
        skipped: [],
        outputPath: "./output",
        stats: {
          totalPages: 0,
          totalSkipped: 0,
          duration: 0,
        },
      };

      expect(result.pages).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.outputPath).toBe("./output");
      expect(result.stats.totalPages).toBe(0);
      expect(result.stats.totalSkipped).toBe(0);
      expect(result.stats.duration).toBe(0);
    });

    it("should allow optional indexPath and singleFilePath", () => {
      const result: FetchResult = {
        pages: [],
        skipped: [],
        outputPath: "./output",
        indexPath: "./output/index.md",
        singleFilePath: "./output/all.md",
        stats: {
          totalPages: 10,
          totalSkipped: 2,
          duration: 5000,
        },
      };

      expect(result.indexPath).toBe("./output/index.md");
      expect(result.singleFilePath).toBe("./output/all.md");
    });
  });
});

describe("LLM types (src/llm/types.ts)", () => {
  describe("LLMCallSiteKey", () => {
    it("should include all 7 call site keys from the design document", () => {
      // We construct an array of all valid LLMCallSiteKey values.
      // If the union type changes, this will fail to compile.
      const allKeys: LLMCallSiteKey[] = [
        "link-classifier",
        "conversion-strategy-selector",
        "conversion-optimizer",
        "agent-router",
        "page-summarizer",
        "index-generator",
        "link-classifier-per-link",
      ];

      expect(allKeys).toHaveLength(7);
      expect(allKeys).toContain("link-classifier");
      expect(allKeys).toContain("conversion-strategy-selector");
      expect(allKeys).toContain("conversion-optimizer");
      expect(allKeys).toContain("agent-router");
      expect(allKeys).toContain("page-summarizer");
      expect(allKeys).toContain("index-generator");
      expect(allKeys).toContain("link-classifier-per-link");
    });

    it("should have no duplicate keys", () => {
      const allKeys: LLMCallSiteKey[] = [
        "link-classifier",
        "conversion-strategy-selector",
        "conversion-optimizer",
        "agent-router",
        "page-summarizer",
        "index-generator",
        "link-classifier-per-link",
      ];
      const uniqueKeys = new Set(allKeys);
      expect(uniqueKeys.size).toBe(allKeys.length);
    });
  });

  describe("InvokeOptions", () => {
    it("should accept all optional fields", () => {
      const options: InvokeOptions = {
        callSite: "page-summarizer",
        model: "gpt-4o",
        temperature: 0.5,
        maxTokens: 2048,
        timeout: 30000,
      };

      expect(options.callSite).toBe("page-summarizer");
      expect(options.model).toBe("gpt-4o");
      expect(options.temperature).toBe(0.5);
      expect(options.maxTokens).toBe(2048);
      expect(options.timeout).toBe(30000);
    });

    it("should accept an empty options object", () => {
      const options: InvokeOptions = {};
      expect(options.callSite).toBeUndefined();
      expect(options.model).toBeUndefined();
    });
  });

  describe("LLMCallSiteConfig", () => {
    it("should accept all optional override fields", () => {
      const config: LLMCallSiteConfig = {
        model: "claude-sonnet-4-20250514",
        temperature: 0.3,
        maxTokens: 1024,
        timeout: 15000,
        maxRetries: 2,
      };

      expect(config.model).toBe("claude-sonnet-4-20250514");
      expect(config.temperature).toBe(0.3);
      expect(config.maxTokens).toBe(1024);
      expect(config.timeout).toBe(15000);
      expect(config.maxRetries).toBe(2);
    });

    it("should accept an empty config object", () => {
      const config: LLMCallSiteConfig = {};
      expect(Object.keys(config)).toHaveLength(0);
    });
  });

  describe("LLMConfig", () => {
    it("should work with only defaults (no callSites)", () => {
      const config: LLMConfig = {
        defaults: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      };

      expect(config.defaults.provider).toBe("anthropic");
      expect(config.defaults.model).toBe("claude-sonnet-4-20250514");
      expect(config.callSites).toBeUndefined();
    });

    it("should work with defaults and callSites", () => {
      const config: LLMConfig = {
        defaults: {
          provider: "openai",
          model: "gpt-4o",
          temperature: 0.7,
          maxTokens: 4096,
          timeout: 30000,
          maxRetries: 3,
        },
        callSites: {
          "link-classifier": { model: "gpt-4o-mini", temperature: 0 },
          "page-summarizer": { maxTokens: 2048 },
          "index-generator": { temperature: 0.2, maxRetries: 5 },
        },
      };

      expect(config.defaults.provider).toBe("openai");
      expect(config.callSites).toBeDefined();
      expect(config.callSites!["link-classifier"]?.model).toBe("gpt-4o-mini");
      expect(config.callSites!["page-summarizer"]?.maxTokens).toBe(2048);
      expect(config.callSites!["index-generator"]?.temperature).toBe(0.2);
    });

    it("should accept all optional fields in defaults", () => {
      const config: LLMConfig = {
        defaults: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          temperature: 0.5,
          maxTokens: 8192,
          timeout: 60000,
          maxRetries: 5,
        },
      };

      expect(config.defaults.temperature).toBe(0.5);
      expect(config.defaults.maxTokens).toBe(8192);
      expect(config.defaults.timeout).toBe(60000);
      expect(config.defaults.maxRetries).toBe(5);
    });
  });

  describe("LLMProvider interface", () => {
    it("should define invoke and invokeStructured methods", () => {
      // We can't directly test an interface at runtime, but we can
      // create a mock that satisfies the interface and verify it works.
      const mockProvider: LLMProvider = {
        invoke: async (_prompt: string, _options?: InvokeOptions) => {
          return "mock response";
        },
        invokeStructured: async <T>(
          _prompt: string,
          _schema: unknown,
          _options?: InvokeOptions,
        ): Promise<T> => {
          return { result: true } as T;
        },
      };

      expect(typeof mockProvider.invoke).toBe("function");
      expect(typeof mockProvider.invokeStructured).toBe("function");
    });

    it("should return a Promise<string> from invoke", async () => {
      const mockProvider: LLMProvider = {
        invoke: async () => "test response",
        invokeStructured: async () => ({}) as any,
      };

      const result = await mockProvider.invoke("test prompt");
      expect(result).toBe("test response");
      expect(typeof result).toBe("string");
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Fetcher } from "../fetcher/index.js";
import type { Converter } from "../converter/index.js";
import type { OutputWriter } from "../output/index.js";
import type { LLMProvider } from "../llm/types.js";
import type { WebsiteFetchConfig, FetchedPage, FetchedPageRaw, SkippedPage } from "../types.js";
import { TempStorage } from "../crawler/temp-storage.js";
import { buildAgentTools } from "../crawler/agent-tools.js";
import type { AgentToolContext } from "../crawler/agent-tools.js";
import { normalizeUrl } from "../crawler/base.js";

// ---------------------------------------------------------------------------
// Mock the ai module and llm modules used by AgentCrawler
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  generateText: vi.fn(),
  tool: vi.fn((def: { description: string; parameters: unknown; execute: Function }) => def),
}));

vi.mock("../llm/provider.js", () => ({
  getModel: vi.fn(async () => "mock-model"),
}));

vi.mock("../llm/config.js", () => ({
  resolveCallSiteConfig: vi.fn((_config: unknown, _callSite: string) => ({
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    temperature: 0,
    maxTokens: 4096,
    maxRetries: 2,
  })),
}));

// Import AFTER mocks are set up
import { generateText } from "ai";
import { AgentCrawler } from "../crawler/agent.js";

const mockGenerateText = vi.mocked(generateText);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<WebsiteFetchConfig> = {},
): WebsiteFetchConfig {
  return {
    url: "https://example.com",
    mode: "agent",
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
    llmConfig: {
      defaults: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        temperature: 0,
        maxTokens: 4096,
      },
    },
    ...overrides,
  };
}

function makeFetchedPageRaw(
  url: string,
  html: string = "<html><body><h1>Page</h1></body></html>",
): FetchedPageRaw {
  return {
    url,
    html,
    statusCode: 200,
    headers: { "content-type": "text/html" },
    fetchedAt: new Date(),
  };
}

function makeHtml(links: string[]): string {
  const anchors = links
    .map((href) => `<p><a href="${href}">Link to ${href}</a></p>`)
    .join("\n");
  return `<html><body><h1>Page</h1>${anchors}</body></html>`;
}

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

function createMockConverter(): Converter {
  return {
    convert: vi.fn(async (_html: string, url: string) => {
      return `# Converted: ${url}`;
    }),
  };
}

function createMockOutputWriter(): OutputWriter {
  return {
    writePage: vi.fn(async () => "output/path.md"),
    urlToFilePath: vi.fn((url: string) => `output/${url}`),
  };
}

function createMockLLM(): LLMProvider & {
  invoke: ReturnType<typeof vi.fn>;
  invokeStructured: ReturnType<typeof vi.fn>;
} {
  return {
    invoke: vi.fn(async () => "This is a summary of the page content."),
    invokeStructured: vi.fn(),
  };
}

/**
 * Build a mock AgentToolContext for direct tool testing.
 */
function createToolContext(
  overrides: Partial<AgentToolContext> = {},
): AgentToolContext {
  const config = makeConfig();
  return {
    config,
    fetcher: createMockFetcher({}),
    converter: createMockConverter(),
    outputWriter: createMockOutputWriter(),
    llm: createMockLLM(),
    tempStorage: new TempStorage(),
    description: "Test crawl description",
    storedPages: [],
    skippedPages: [],
    summaries: new Map(),
    storedCount: 0,
    done: false,
    ...overrides,
  };
}

/**
 * Helper to simulate generateText returning tool call results then done.
 * Each call to generateText triggers tool executions via the tools param.
 * We simulate by calling the tool execute functions directly from our mock.
 */
function setupGenerateTextSequence(
  toolCallSequence: Array<{
    toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
    finishReason?: string;
  }>,
) {
  let callIndex = 0;

  mockGenerateText.mockImplementation(async (params: any) => {
    if (callIndex >= toolCallSequence.length) {
      // No more planned calls -- return stop with no tool calls
      return {
        text: "I am done.",
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        response: { messages: [] },
      } as any;
    }

    const sequence = toolCallSequence[callIndex];
    callIndex++;

    const toolResults: Array<{ toolName: string; result: unknown }> = [];

    // Execute the tools via the tools parameter
    for (const tc of sequence.toolCalls) {
      const toolDef = params.tools?.[tc.toolName];
      if (toolDef && typeof toolDef.execute === "function") {
        const result = await toolDef.execute(tc.args);
        toolResults.push({ toolName: tc.toolName, result });
      }
    }

    return {
      text: "",
      toolCalls: sequence.toolCalls.map((tc) => ({
        type: "tool-call" as const,
        toolCallId: `call-${callIndex}-${tc.toolName}`,
        toolName: tc.toolName,
        args: tc.args,
      })),
      toolResults,
      finishReason: sequence.finishReason ?? "tool-calls",
      response: {
        messages: [
          {
            role: "assistant",
            content: [
              ...sequence.toolCalls.map((tc) => ({
                type: "tool-call" as const,
                toolCallId: `call-${callIndex}-${tc.toolName}`,
                toolName: tc.toolName,
                args: tc.args,
              })),
            ],
          },
          ...toolResults.map((tr) => ({
            role: "tool",
            content: [
              {
                type: "tool-result" as const,
                toolCallId: `call-${callIndex}-${tr.toolName}`,
                result: tr.result,
              },
            ],
          })),
        ],
      },
    } as any;
  });
}

// ---------------------------------------------------------------------------
// Agent Tool Tests (individual tools)
// ---------------------------------------------------------------------------
describe("Agent Tools", () => {
  // -------------------------------------------------------------------------
  // fetchPage tool
  // -------------------------------------------------------------------------
  describe("fetchPage", () => {
    it("should fetch, convert, store in temp, summarize, and return summary", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });
      const converter = createMockConverter();
      const llm = createMockLLM();
      llm.invoke.mockResolvedValue("This page is about example content.");

      const ctx = createToolContext({ fetcher, converter, llm });
      const tools = buildAgentTools(ctx);

      const result = await tools.fetchPage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Should have fetched
      expect(fetcher.fetch).toHaveBeenCalledWith("https://example.com");
      // Should have converted
      expect(converter.convert).toHaveBeenCalled();
      // Should have stored in temp
      expect(ctx.tempStorage.has(normalizeUrl("https://example.com"))).toBe(true);
      // Should have summarized via LLM
      expect(llm.invoke).toHaveBeenCalledWith(
        expect.stringContaining("Summarize"),
        expect.objectContaining({ callSite: "page-summarizer" }),
      );
      // Should return summary text
      expect(result).toContain("This page is about example content.");
      expect(result).toContain("Page fetched successfully");
    });

    it("should return cached summary for already-fetched URL", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });
      const ctx = createToolContext({ fetcher });

      // Pre-populate temp storage and summary cache
      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");
      ctx.summaries.set(normalized, "Cached summary");

      const tools = buildAgentTools(ctx);

      const result = await tools.fetchPage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Should NOT re-fetch
      expect(fetcher.fetch).not.toHaveBeenCalled();
      // Should return cached summary
      expect(result).toContain("Cached summary");
      expect(result).toContain("Page already fetched");
    });

    it("should handle fetch errors gracefully and return error message", async () => {
      const fetcher = createMockFetcher({
        "https://example.com/broken": new Error("Network timeout"),
      });
      const ctx = createToolContext({ fetcher });
      const tools = buildAgentTools(ctx);

      const result = await tools.fetchPage.execute(
        { url: "https://example.com/broken" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Failed to fetch page");
      expect(result).toContain("Network timeout");
    });

    it("should fall back to first 500 chars when LLM summarization fails", async () => {
      const longMarkdown = "A".repeat(600);
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });
      const converter: Converter = {
        convert: vi.fn(async () => longMarkdown),
      };
      const llm = createMockLLM();
      llm.invoke.mockRejectedValue(new Error("LLM API down"));

      const ctx = createToolContext({ fetcher, converter, llm });
      const tools = buildAgentTools(ctx);

      const result = await tools.fetchPage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Should contain truncated content with ellipsis
      expect(result).toContain("A".repeat(500));
      expect(result).toContain("...");
      // Should still be stored in temp
      expect(ctx.tempStorage.has(normalizeUrl("https://example.com"))).toBe(true);
    });

    it("should truncate markdown to 8000 chars when sending to page-summarizer", async () => {
      const longMarkdown = "B".repeat(10000);
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });
      const converter: Converter = {
        convert: vi.fn(async () => longMarkdown),
      };
      const llm = createMockLLM();
      llm.invoke.mockResolvedValue("Summary");

      const ctx = createToolContext({ fetcher, converter, llm });
      const tools = buildAgentTools(ctx);

      await tools.fetchPage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // The prompt sent to LLM should contain at most 8000 chars of content
      const promptArg = llm.invoke.mock.calls[0][0] as string;
      // The content section should be truncated
      expect(promptArg.length).toBeLessThan(longMarkdown.length + 500); // 500 for prompt text
    });
  });

  // -------------------------------------------------------------------------
  // storePage tool
  // -------------------------------------------------------------------------
  describe("storePage", () => {
    it("should move page from temp to output and return links", async () => {
      const outputWriter = createMockOutputWriter();
      const config = makeConfig();
      const ctx = createToolContext({ config, outputWriter });

      // Pre-populate temp storage
      const html = makeHtml(["https://example.com/about"]);
      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com", html), "# test");

      const tools = buildAgentTools(ctx);

      const result = await tools.storePage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Should have written to output
      expect(outputWriter.writePage).toHaveBeenCalledTimes(1);
      // Should have tracked stored page
      expect(ctx.storedPages).toHaveLength(1);
      expect(ctx.storedCount).toBe(1);
      // Should have removed from temp
      expect(ctx.tempStorage.has(normalized)).toBe(false);
      // Should return confirmation and links
      expect(result).toContain("Page stored successfully");
      expect(result).toContain("1/100"); // storedCount/maxPages
      expect(result).toContain("Links found on this page");
    });

    it("should return error when URL is not in temp storage", async () => {
      const ctx = createToolContext();
      const tools = buildAgentTools(ctx);

      const result = await tools.storePage.execute(
        { url: "https://example.com/not-fetched" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Page not found in temporary storage");
      expect(result).toContain("must fetch it first");
    });

    it("should return error when maxPages limit is reached", async () => {
      const config = makeConfig({ maxPages: 2 });
      const ctx = createToolContext({ config });
      ctx.storedCount = 2; // Already at limit

      // Pre-populate temp
      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");

      const tools = buildAgentTools(ctx);

      const result = await tools.storePage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Cannot store page");
      expect(result).toContain("maximum page limit");
    });

    it("should set depth to 0 for stored pages", async () => {
      const ctx = createToolContext();

      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");

      const tools = buildAgentTools(ctx);

      await tools.storePage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(ctx.storedPages[0].depth).toBe(0);
    });

    it("should fire onPageFetched callback", async () => {
      const onPageFetched = vi.fn();
      const config = makeConfig({ onPageFetched });
      const ctx = createToolContext({ config });

      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");

      const tools = buildAgentTools(ctx);

      await tools.storePage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(onPageFetched).toHaveBeenCalledTimes(1);
      expect(onPageFetched.mock.calls[0][0].url).toBe("https://example.com");
    });

    it("should handle output writer failure gracefully", async () => {
      const outputWriter: OutputWriter = {
        writePage: vi.fn(async () => {
          throw new Error("Disk full");
        }),
        urlToFilePath: vi.fn(() => "output/path.md"),
      };
      const ctx = createToolContext({ outputWriter });

      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");

      const tools = buildAgentTools(ctx);

      const result = await tools.storePage.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Failed to write page to output");
      expect(result).toContain("Disk full");
      // Should NOT have tracked the page as stored
      expect(ctx.storedCount).toBe(0);
      expect(ctx.storedPages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // markIrrelevant tool
  // -------------------------------------------------------------------------
  describe("markIrrelevant", () => {
    it("should remove page from temp, track as skipped, and return links", async () => {
      const ctx = createToolContext();

      const html = makeHtml(["https://example.com/about"]);
      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com", html), "# test");

      const tools = buildAgentTools(ctx);

      const result = await tools.markIrrelevant.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Should be removed from temp
      expect(ctx.tempStorage.has(normalized)).toBe(false);
      // Should be tracked as skipped
      expect(ctx.skippedPages).toHaveLength(1);
      expect(ctx.skippedPages[0].url).toBe(normalized);
      expect(ctx.skippedPages[0].reason).toContain("irrelevant");
      // Should return links and confirmation
      expect(result).toContain("marked as irrelevant");
      expect(result).toContain("Links found on this page");
    });

    it("should return error when URL is not in temp storage", async () => {
      const ctx = createToolContext();
      const tools = buildAgentTools(ctx);

      const result = await tools.markIrrelevant.execute(
        { url: "https://example.com/not-fetched" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Page not found in temporary storage");
    });

    it("should fire onPageSkipped callback", async () => {
      const onPageSkipped = vi.fn();
      const config = makeConfig({ onPageSkipped });
      const ctx = createToolContext({ config });

      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");

      const tools = buildAgentTools(ctx);

      await tools.markIrrelevant.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(onPageSkipped).toHaveBeenCalledTimes(1);
      expect(onPageSkipped).toHaveBeenCalledWith(
        "https://example.com",
        expect.stringContaining("irrelevant"),
      );
    });

    it("should use normalized URL when tracking skipped pages", async () => {
      const ctx = createToolContext();

      // Store with normalized URL
      const normalized = normalizeUrl("https://example.com/page/");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com/page/"), "# test");

      const tools = buildAgentTools(ctx);

      await tools.markIrrelevant.execute(
        { url: "https://example.com/page/" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Should use normalized URL in skippedPages
      expect(ctx.skippedPages[0].url).toBe(normalized);
    });
  });

  // -------------------------------------------------------------------------
  // getLinks tool
  // -------------------------------------------------------------------------
  describe("getLinks", () => {
    it("should return links from a page in temp storage", async () => {
      const ctx = createToolContext();

      const html = makeHtml([
        "https://example.com/about",
        "https://example.com/docs",
      ]);
      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com", html), "# test");

      const tools = buildAgentTools(ctx);

      const result = await tools.getLinks.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("https://example.com/about");
      expect(result).toContain("https://example.com/docs");
    });

    it("should not modify temp storage state", async () => {
      const ctx = createToolContext();

      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com"), "# test");

      const tools = buildAgentTools(ctx);

      await tools.getLinks.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      // Page should still be in temp storage
      expect(ctx.tempStorage.has(normalized)).toBe(true);
    });

    it("should return error when URL is not in temp storage", async () => {
      const ctx = createToolContext();
      const tools = buildAgentTools(ctx);

      const result = await tools.getLinks.execute(
        { url: "https://example.com/not-fetched" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Page not found in temporary storage");
      expect(result).toContain("must fetch it first");
    });

    it("should return no links message for page with no links", async () => {
      const ctx = createToolContext();

      const html = "<html><body><h1>No links</h1></body></html>";
      const normalized = normalizeUrl("https://example.com");
      ctx.tempStorage.store(normalized, makeFetchedPageRaw("https://example.com", html), "# test");

      const tools = buildAgentTools(ctx);

      const result = await tools.getLinks.execute(
        { url: "https://example.com" },
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("No links found");
    });
  });

  // -------------------------------------------------------------------------
  // done tool
  // -------------------------------------------------------------------------
  describe("done", () => {
    it("should set done flag to true", async () => {
      const ctx = createToolContext();
      const tools = buildAgentTools(ctx);

      expect(ctx.done).toBe(false);

      await tools.done.execute(
        {},
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(ctx.done).toBe(true);
    });

    it("should return stored count in completion message", async () => {
      const ctx = createToolContext();
      ctx.storedCount = 5;
      const tools = buildAgentTools(ctx);

      const result = await tools.done.execute(
        {},
        { toolCallId: "test", messages: [], abortSignal: undefined as any },
      );

      expect(result).toContain("Crawl complete");
      expect(result).toContain("5");
    });
  });
});

// ---------------------------------------------------------------------------
// AgentCrawler Tests (conversation loop integration)
// ---------------------------------------------------------------------------
describe("AgentCrawler", () => {
  let mockConverter: Converter;
  let mockOutputWriter: OutputWriter;
  let mockLLM: ReturnType<typeof createMockLLM>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConverter = createMockConverter();
    mockOutputWriter = createMockOutputWriter();
    mockLLM = createMockLLM();
  });

  // -------------------------------------------------------------------------
  // llmConfig guard
  // -------------------------------------------------------------------------
  describe("llmConfig guard", () => {
    it("should throw if llmConfig is not configured", async () => {
      const config = makeConfig({ llmConfig: undefined });
      const fetcher = createMockFetcher({});
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test description",
      );

      await expect(crawler.crawl()).rejects.toThrow(
        "Agent mode requires llmConfig to be configured",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Basic conversation loop
  // -------------------------------------------------------------------------
  describe("basic conversation loop", () => {
    it("should execute a simple fetch-store-done flow", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });

      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test description",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
      expect(result.pages[0].depth).toBe(0);
      expect(mockOutputWriter.writePage).toHaveBeenCalledTimes(1);
    });

    it("should accumulate conversation messages across turns", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });

      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test description",
      );

      await crawler.crawl();

      // generateText should have been called 2 times
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // Second call should have messages from the first turn
      const secondCallArgs = mockGenerateText.mock.calls[1][0] as any;
      expect(secondCallArgs.messages.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-page crawl
  // -------------------------------------------------------------------------
  describe("multi-page crawl", () => {
    it("should fetch multiple pages and store relevant ones", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml(["https://example.com/about"]) },
        "https://example.com/about": { html: makeHtml([]) },
      });

      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com/about" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com/about" } }],
        },
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Get all pages",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2);
      const urls = result.pages.map((p) => p.url);
      expect(urls).toContain("https://example.com");
      expect(urls).toContain("https://example.com/about");
    });

    it("should handle fetch-and-mark-irrelevant flow", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
        "https://example.com/blog": { html: makeHtml([]) },
      });

      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com/blog" } }],
        },
        {
          toolCalls: [{ toolName: "markIrrelevant", args: { url: "https://example.com/blog" } }],
        },
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Only docs",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
      // Blog should be in skipped
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].url).toBe(normalizeUrl("https://example.com/blog"));
      expect(result.skipped[0].reason).toContain("irrelevant");
    });
  });

  // -------------------------------------------------------------------------
  // maxPages limit
  // -------------------------------------------------------------------------
  describe("maxPages limit", () => {
    it("should stop when maxPages is reached", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
        "https://example.com/a": { html: makeHtml([]) },
        "https://example.com/b": { html: makeHtml([]) },
      });

      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com/a" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com/a" } }],
        },
        // This should not execute because maxPages=2 is reached
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com/b" } }],
        },
      ]);

      const config = makeConfig({ maxPages: 2 });
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(2);
      // The third fetch should not have happened
      expect(mockGenerateText).toHaveBeenCalledTimes(4); // 4 turns, broke after storePage for /a
    });
  });

  // -------------------------------------------------------------------------
  // done() terminates loop
  // -------------------------------------------------------------------------
  describe("done terminates loop", () => {
    it("should stop immediately when agent calls done()", async () => {
      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const fetcher = createMockFetcher({});
      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // No pages should be stored
      expect(result.pages).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Text response with no tool calls (stop)
  // -------------------------------------------------------------------------
  describe("text response with no tool calls", () => {
    it("should break loop when model returns text with no tool calls (finishReason=stop)", async () => {
      // Simulate the model producing a text response with finishReason 'stop'
      mockGenerateText.mockResolvedValueOnce({
        text: "I think I am done.",
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        response: { messages: [{ role: "assistant", content: "I think I am done." }] },
      } as any);

      const fetcher = createMockFetcher({});
      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(0);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // LLM error handling
  // -------------------------------------------------------------------------
  describe("LLM error handling", () => {
    it("should handle LLM error gracefully and return partial results", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });

      let callCount = 0;
      mockGenerateText.mockImplementation(async (params: any) => {
        callCount++;
        if (callCount === 1) {
          // First call succeeds: fetch page
          const tools = params.tools;
          const result = await tools.fetchPage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c1", toolName: "fetchPage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 2) {
          // Second call succeeds: store page
          const tools = params.tools;
          const result = await tools.storePage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c2", toolName: "storePage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "storePage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        // Third call fails
        throw new Error("LLM API error");
      });

      const onError = vi.fn();
      const config = makeConfig({ onError });
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // Should have the one stored page from before the error
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");
      // Should have called onError
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("https://example.com", expect.any(Error));
    });
  });

  // -------------------------------------------------------------------------
  // Skipped pages from remaining tempStorage
  // -------------------------------------------------------------------------
  describe("remaining tempStorage entries as skipped", () => {
    it("should mark pages left in tempStorage as skipped at crawl end", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
        "https://example.com/orphan": { html: makeHtml([]) },
      });

      let callCount = 0;
      mockGenerateText.mockImplementation(async (params: any) => {
        callCount++;
        const tools = params.tools;

        if (callCount === 1) {
          // Fetch root
          const result = await tools.fetchPage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c1", toolName: "fetchPage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 2) {
          // Fetch orphan page but don't store or mark it
          const result = await tools.fetchPage.execute({ url: "https://example.com/orphan" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c2", toolName: "fetchPage", args: { url: "https://example.com/orphan" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 3) {
          // Store root only
          const result = await tools.storePage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c3", toolName: "storePage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "storePage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 4) {
          // Done -- orphan is still in tempStorage
          const result = await tools.done.execute({});
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c4", toolName: "done", args: {} }],
            toolResults: [{ toolName: "done", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        return {
          text: "done",
          toolCalls: [],
          toolResults: [],
          finishReason: "stop",
          response: { messages: [] },
        } as any;
      });

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].url).toBe("https://example.com");

      // The orphan page should be in skipped with appropriate reason
      const orphanSkipped = result.skipped.find(
        (s) => s.url === normalizeUrl("https://example.com/orphan"),
      );
      expect(orphanSkipped).toBeDefined();
      expect(orphanSkipped!.reason).toContain("Fetched but not stored");
    });
  });

  // -------------------------------------------------------------------------
  // FetchResult stats
  // -------------------------------------------------------------------------
  describe("FetchResult stats", () => {
    it("should return correct FetchResult with pages, skipped, and stats", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });

      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "fetchPage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com" } }],
        },
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const config = makeConfig({ outputDir: "/my/output" });
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(1);
      expect(result.outputPath).toBe("/my/output");
      expect(result.stats.totalPages).toBe(1);
      expect(result.stats.totalSkipped).toBe(0);
      expect(result.stats.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // System prompt
  // -------------------------------------------------------------------------
  describe("system prompt", () => {
    it("should include description, URL, maxPages, and tool instructions in system prompt", async () => {
      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const fetcher = createMockFetcher({});
      const config = makeConfig({ maxPages: 42 });
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Find all API documentation",
      );

      await crawler.crawl();

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      const systemPrompt = callArgs.system as string;

      expect(systemPrompt).toContain("Find all API documentation");
      expect(systemPrompt).toContain("https://example.com");
      expect(systemPrompt).toContain("42"); // maxPages
      expect(systemPrompt).toContain("fetchPage");
      expect(systemPrompt).toContain("storePage");
      expect(systemPrompt).toContain("markIrrelevant");
      expect(systemPrompt).toContain("getLinks");
      expect(systemPrompt).toContain("done");
    });
  });

  // -------------------------------------------------------------------------
  // Tool parameters passed to generateText
  // -------------------------------------------------------------------------
  describe("tools passed to generateText", () => {
    it("should pass all 5 tools to generateText", async () => {
      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const fetcher = createMockFetcher({});
      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      const toolNames = Object.keys(callArgs.tools);

      expect(toolNames).toContain("fetchPage");
      expect(toolNames).toContain("storePage");
      expect(toolNames).toContain("markIrrelevant");
      expect(toolNames).toContain("getLinks");
      expect(toolNames).toContain("done");
      expect(toolNames).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // MAX_STEPS_PER_TURN
  // -------------------------------------------------------------------------
  describe("maxSteps configuration", () => {
    it("should pass maxSteps=10 to generateText", async () => {
      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const fetcher = createMockFetcher({});
      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.maxSteps).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("should handle agent calling done immediately (no pages stored)", async () => {
      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const fetcher = createMockFetcher({});
      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      expect(result.pages).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      expect(result.stats.totalPages).toBe(0);
    });

    it("should handle agent calling storePage on URL not in temp (graceful error)", async () => {
      setupGenerateTextSequence([
        {
          toolCalls: [{ toolName: "storePage", args: { url: "https://example.com/not-fetched" } }],
        },
        {
          toolCalls: [{ toolName: "done", args: {} }],
        },
      ]);

      const fetcher = createMockFetcher({});
      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // Should not crash, just no pages stored
      expect(result.pages).toHaveLength(0);
    });

    it("should handle agent calling fetchPage on already-fetched URL (return cached summary)", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": { html: makeHtml([]) },
      });

      let callCount = 0;
      mockGenerateText.mockImplementation(async (params: any) => {
        callCount++;
        const tools = params.tools;

        if (callCount === 1) {
          const result = await tools.fetchPage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c1", toolName: "fetchPage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 2) {
          // Fetch same URL again
          const result = await tools.fetchPage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c2", toolName: "fetchPage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 3) {
          const result = await tools.done.execute({});
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c3", toolName: "done", args: {} }],
            toolResults: [{ toolName: "done", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        return {
          text: "done",
          toolCalls: [],
          toolResults: [],
          finishReason: "stop",
          response: { messages: [] },
        } as any;
      });

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      await crawler.crawl();

      // Fetcher should only be called once (second time uses cached summary)
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    });

    it("should handle non-Error throws in LLM loop gracefully", async () => {
      mockGenerateText.mockRejectedValueOnce("string error");

      const fetcher = createMockFetcher({});
      const onError = vi.fn();
      const config = makeConfig({ onError });
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Test",
      );

      const result = await crawler.crawl();

      // Should not crash, returns empty result
      expect(result.pages).toHaveLength(0);
      // onError should be called with the config URL
      expect(onError).toHaveBeenCalledWith("https://example.com", expect.any(Error));
    });
  });

  // -------------------------------------------------------------------------
  // Integration: Full agent crawl
  // -------------------------------------------------------------------------
  describe("integration: full agent crawl with mocked dependencies", () => {
    it("should perform a complete crawl storing relevant pages and skipping irrelevant ones", async () => {
      const fetcher = createMockFetcher({
        "https://example.com": {
          html: makeHtml(["https://example.com/docs", "https://example.com/blog"]),
        },
        "https://example.com/docs": {
          html: makeHtml(["https://example.com/docs/api"]),
        },
        "https://example.com/blog": {
          html: makeHtml([]),
        },
        "https://example.com/docs/api": {
          html: makeHtml([]),
        },
      });

      let callCount = 0;
      mockGenerateText.mockImplementation(async (params: any) => {
        callCount++;
        const tools = params.tools;

        if (callCount === 1) {
          const result = await tools.fetchPage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c1", toolName: "fetchPage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 2) {
          const result = await tools.storePage.execute({ url: "https://example.com" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c2", toolName: "storePage", args: { url: "https://example.com" } }],
            toolResults: [{ toolName: "storePage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 3) {
          const result = await tools.fetchPage.execute({ url: "https://example.com/docs" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c3", toolName: "fetchPage", args: { url: "https://example.com/docs" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 4) {
          const result = await tools.storePage.execute({ url: "https://example.com/docs" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c4", toolName: "storePage", args: { url: "https://example.com/docs" } }],
            toolResults: [{ toolName: "storePage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 5) {
          const result = await tools.fetchPage.execute({ url: "https://example.com/blog" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c5", toolName: "fetchPage", args: { url: "https://example.com/blog" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 6) {
          const result = await tools.markIrrelevant.execute({ url: "https://example.com/blog" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c6", toolName: "markIrrelevant", args: { url: "https://example.com/blog" } }],
            toolResults: [{ toolName: "markIrrelevant", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 7) {
          const result = await tools.fetchPage.execute({ url: "https://example.com/docs/api" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c7", toolName: "fetchPage", args: { url: "https://example.com/docs/api" } }],
            toolResults: [{ toolName: "fetchPage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 8) {
          const result = await tools.storePage.execute({ url: "https://example.com/docs/api" });
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c8", toolName: "storePage", args: { url: "https://example.com/docs/api" } }],
            toolResults: [{ toolName: "storePage", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }
        if (callCount === 9) {
          const result = await tools.done.execute({});
          return {
            text: "",
            toolCalls: [{ type: "tool-call", toolCallId: "c9", toolName: "done", args: {} }],
            toolResults: [{ toolName: "done", result }],
            finishReason: "tool-calls",
            response: { messages: [] },
          } as any;
        }

        return {
          text: "done",
          toolCalls: [],
          toolResults: [],
          finishReason: "stop",
          response: { messages: [] },
        } as any;
      });

      const config = makeConfig();
      const crawler = new AgentCrawler(
        config,
        fetcher,
        mockConverter,
        mockOutputWriter,
        mockLLM,
        "Fetch all documentation",
      );

      const result = await crawler.crawl();

      // Should have stored root, /docs, and /docs/api
      expect(result.pages).toHaveLength(3);
      const storedUrls = result.pages.map((p) => p.url);
      expect(storedUrls).toContain("https://example.com");
      expect(storedUrls).toContain("https://example.com/docs");
      expect(storedUrls).toContain("https://example.com/docs/api");

      // /blog should be in skipped
      const skippedUrls = result.skipped.map((s) => s.url);
      expect(skippedUrls).toContain(normalizeUrl("https://example.com/blog"));

      // Stats should be correct
      expect(result.stats.totalPages).toBe(3);
      expect(result.stats.totalSkipped).toBe(1);
    });
  });
});

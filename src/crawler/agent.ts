import { generateText } from 'ai';
import type { CoreMessage } from 'ai';

import type {
  WebsiteFetchConfig,
  FetchedPage,
  FetchResult,
  SkippedPage,
} from '../types.js';
import type { Fetcher } from '../fetcher/index.js';
import type { Converter } from '../converter/index.js';
import type { OutputWriter } from '../output/index.js';
import type { LLMProvider } from '../llm/types.js';
import { getModel } from '../llm/provider.js';
import { resolveCallSiteConfig } from '../llm/config.js';
import { TempStorage } from './temp-storage.js';
import { buildFetchResult } from './base.js';
import { buildAgentTools } from './agent-tools.js';
import type { AgentToolContext } from './agent-tools.js';

/** Maximum number of conversation turns as a safety net. */
const MAX_CONVERSATION_TURNS = 100;

/** Maximum tool call steps per generateText invocation. */
const MAX_STEPS_PER_TURN = 10;

/**
 * Build the system prompt for the agent crawler.
 *
 * Includes the crawl description, tool usage instructions, and constraints
 * (such as maxPages limit).
 */
function buildSystemPrompt(config: WebsiteFetchConfig, description: string): string {
  return (
    `You are a web crawling agent. Your goal is to crawl a website and collect relevant pages.\n\n` +
    `## Crawl Goal\n` +
    `${description}\n\n` +
    `## Starting URL\n` +
    `${config.url}\n\n` +
    `## Constraints\n` +
    `- You can store at most ${config.maxPages} pages\n` +
    `- Only store pages that are relevant to the crawl goal\n` +
    `- When you have collected enough relevant pages, or there are no more relevant pages to explore, call done()\n\n` +
    `## Available Tools\n` +
    `1. **fetchPage(url)** - Fetch a page and get a summary of its content. Always start by fetching the starting URL.\n` +
    `2. **storePage(url)** - Store a fetched page to the output (only if relevant to the goal). Returns links found on the page.\n` +
    `3. **markIrrelevant(url)** - Discard a fetched page that is not relevant. Returns links found on the page.\n` +
    `4. **getLinks(url)** - Get links from a fetched page without storing or discarding it.\n` +
    `5. **done()** - Signal that the crawl is complete.\n\n` +
    `## Workflow\n` +
    `1. Fetch the starting URL first\n` +
    `2. Review the summary to understand the page content\n` +
    `3. If relevant, store the page; if not, mark it as irrelevant\n` +
    `4. Both storePage and markIrrelevant return links found on the page\n` +
    `5. Choose the most promising links to fetch next based on your goal\n` +
    `6. Repeat until you have enough pages or no more relevant pages to explore\n` +
    `7. Call done() when finished\n\n` +
    `## Important Notes\n` +
    `- You only see page summaries, not full content. The full content is saved when you call storePage.\n` +
    `- Be selective: only fetch pages that seem relevant to the goal\n` +
    `- Do not re-fetch pages you have already fetched\n` +
    `- If a fetch fails, move on to other URLs\n` +
    `- Start now by fetching the starting URL.`
  );
}

/**
 * Agent-based crawler that uses an LLM conversation loop to decide
 * which pages to fetch, store, or skip.
 *
 * The agent maintains context across decisions via its conversation history,
 * only seeing page summaries (not full content) to keep the context window
 * manageable. It uses 5 tools: fetchPage, storePage, markIrrelevant,
 * getLinks, and done.
 *
 * The conversation loop uses the Vercel AI SDK's `generateText` with
 * tool calling support. Each turn allows multiple tool calls via `maxSteps`.
 */
export class AgentCrawler {
  private readonly config: WebsiteFetchConfig;
  private readonly fetcher: Fetcher;
  private readonly converter: Converter;
  private readonly outputWriter: OutputWriter;
  private readonly llm: LLMProvider;
  private readonly description: string;

  constructor(
    config: WebsiteFetchConfig,
    fetcher: Fetcher,
    converter: Converter,
    outputWriter: OutputWriter,
    llm: LLMProvider,
    description: string,
  ) {
    this.config = config;
    this.fetcher = fetcher;
    this.converter = converter;
    this.outputWriter = outputWriter;
    this.llm = llm;
    this.description = description;
  }

  /**
   * Run the agent crawl.
   *
   * Maintains a single conversation with the LLM, providing tool access.
   * The agent decides which URLs to fetch, which pages to store, and when
   * to stop. The loop continues until the agent calls done(), the maxPages
   * limit is reached, or the max conversation turns safety limit is hit.
   *
   * @returns The crawl result including stored pages, skipped pages, and stats
   */
  async crawl(): Promise<FetchResult> {
    if (!this.config.llmConfig) {
      throw new Error('Agent mode requires llmConfig to be configured');
    }

    const startTime = Date.now();

    // Resolve the LLM config for the agent-router call site
    const resolvedConfig = resolveCallSiteConfig(
      this.config.llmConfig,
      'agent-router',
    );
    const model = await getModel(resolvedConfig.provider, resolvedConfig.model);

    // Set up shared context for tools
    const tempStorage = new TempStorage();
    const ctx: AgentToolContext = {
      config: this.config,
      fetcher: this.fetcher,
      converter: this.converter,
      outputWriter: this.outputWriter,
      llm: this.llm,
      tempStorage,
      description: this.description,
      storedPages: [],
      skippedPages: [],
      summaries: new Map(),
      storedCount: 0,
      done: false,
    };

    // Build tools and system prompt
    const tools = buildAgentTools(ctx);
    const systemPrompt = buildSystemPrompt(this.config, this.description);

    // Conversation history
    const messages: CoreMessage[] = [];

    // Conversation loop
    for (let turn = 0; turn < MAX_CONVERSATION_TURNS; turn++) {
      // Check termination conditions
      if (ctx.done) {
        break;
      }

      if (ctx.storedCount >= this.config.maxPages) {
        break;
      }

      try {
        const result = await generateText({
          model,
          system: systemPrompt,
          messages,
          tools,
          maxSteps: MAX_STEPS_PER_TURN,
          temperature: resolvedConfig.temperature,
          maxTokens: resolvedConfig.maxTokens,
          maxRetries: resolvedConfig.maxRetries,
        });

        // Append the response messages to conversation history
        // response.messages contains assistant + tool messages from this turn
        for (const msg of result.response.messages) {
          messages.push(msg as CoreMessage);
        }

        // Check if the agent signaled done via the tool
        if (ctx.done) {
          break;
        }

        // Check if we've hit the maxPages limit after tool execution
        if (ctx.storedCount >= this.config.maxPages) {
          break;
        }

        // If the model finished without calling any tools and produced text,
        // the conversation may be stuck. Check the finish reason.
        if (result.finishReason === 'stop' && result.toolCalls.length === 0) {
          // The agent produced a text response without calling tools.
          // This could mean the agent thinks it's done or is confused.
          // Break to avoid infinite loops.
          break;
        }
      } catch (error) {
        // LLM error in the agent loop - log and attempt graceful termination
        const err = error instanceof Error ? error : new Error(String(error));
        this.config.onError?.(this.config.url, err);
        break;
      }
    }

    // Build skipped pages list: start with pages explicitly marked irrelevant
    const skipped: SkippedPage[] = [...ctx.skippedPages];

    // Add any remaining temp storage entries as skipped (fetched but never stored or discarded)
    for (const url of tempStorage.urls()) {
      skipped.push({ url, reason: 'Fetched but not stored by agent' });
    }

    return buildFetchResult(
      ctx.storedPages,
      skipped,
      this.config.outputDir,
      startTime,
    );
  }
}

import type { ZodSchema } from 'zod';
import { generateText, generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

import type { LLMProvider, LLMConfig, InvokeOptions } from './types.js';
import { resolveCallSiteConfig } from './config.js';
import type { ResolvedLLMConfig } from './config.js';

/**
 * Error thrown when an unsupported LLM provider is requested.
 */
export class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(
      `Unsupported LLM provider: "${provider}". ` +
        `Supported providers: "anthropic", "openai". ` +
        `Ensure the corresponding @ai-sdk package is installed.`,
    );
    this.name = 'UnsupportedProviderError';
  }
}

/**
 * Error thrown when an LLM invocation fails after retries.
 */
export class LLMInvocationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LLMInvocationError';
  }
}

/**
 * Map a provider name and model string to a Vercel AI SDK LanguageModel instance.
 *
 * @param provider - The provider name (e.g., 'anthropic', 'openai')
 * @param model - The model identifier (e.g., 'claude-haiku-4-5-20251001')
 * @returns A LanguageModel instance for use with the Vercel AI SDK
 * @throws UnsupportedProviderError if the provider is not recognized
 */
export async function getModel(
  provider: string,
  model: string,
): Promise<LanguageModel> {
  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic();
      return anthropic(model);
    }
    case 'openai': {
      // Dynamic import: @ai-sdk/openai must be installed separately.
      // Use a variable for the module specifier to prevent TypeScript from
      // attempting static module resolution at compile time.
      type OpenAIModule = {
        createOpenAI: (
          options?: Record<string, unknown>,
        ) => (modelId: string) => LanguageModel;
      };
      const openaiPkg = '@ai-sdk/openai';
      let mod: OpenAIModule;
      try {
        mod = (await import(openaiPkg)) as OpenAIModule;
      } catch {
        throw new UnsupportedProviderError(
          'openai (package @ai-sdk/openai is not installed)',
        );
      }
      const openai = mod.createOpenAI();
      return openai(model);
    }
    default:
      throw new UnsupportedProviderError(provider);
  }
}

/**
 * Default implementation of the LLMProvider interface using the Vercel AI SDK.
 *
 * Routes LLM calls through `generateText` (for plain text) and `generateObject`
 * (for structured output with Zod schema validation). Supports per-call-site
 * configuration, retry logic, and timeout handling via AbortController.
 */
export class DefaultLLMProvider implements LLMProvider {
  constructor(private readonly config: LLMConfig) {}

  /**
   * Invoke the LLM with a plain text prompt and return the generated text.
   *
   * @param prompt - The text prompt to send to the LLM
   * @param options - Optional invocation options (call site, model overrides, etc.)
   * @returns The generated text response
   * @throws LLMInvocationError if the call fails after retries
   */
  async invoke(prompt: string, options?: InvokeOptions): Promise<string> {
    const resolved = this.resolveConfig(options);
    const model = await getModel(resolved.provider, resolved.model);
    const abortController = this.createAbortController(resolved.timeout);

    try {
      const { text } = await generateText({
        model,
        prompt,
        temperature: resolved.temperature,
        maxTokens: resolved.maxTokens,
        maxRetries: resolved.maxRetries,
        abortSignal: abortController?.signal,
      });
      return text;
    } catch (error: unknown) {
      if (this.isAbortError(error)) {
        throw new LLMInvocationError(
          `LLM call timed out after ${resolved.timeout}ms`,
          error,
        );
      }
      throw new LLMInvocationError(
        `LLM text generation failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      abortController?.abort();
    }
  }

  /**
   * Invoke the LLM with a prompt and Zod schema, returning a validated structured object.
   *
   * @param prompt - The text prompt to send to the LLM
   * @param schema - A Zod schema describing the expected output structure
   * @param options - Optional invocation options (call site, model overrides, etc.)
   * @returns The generated object, validated against the schema
   * @throws LLMInvocationError if the call fails after retries or validation fails
   */
  async invokeStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: InvokeOptions,
  ): Promise<T> {
    const resolved = this.resolveConfig(options);
    const model = await getModel(resolved.provider, resolved.model);
    const abortController = this.createAbortController(resolved.timeout);

    try {
      const { object } = await generateObject({
        model,
        prompt,
        schema,
        temperature: resolved.temperature,
        maxTokens: resolved.maxTokens,
        maxRetries: resolved.maxRetries,
        abortSignal: abortController?.signal,
      });
      return object;
    } catch (error: unknown) {
      if (this.isAbortError(error)) {
        throw new LLMInvocationError(
          `LLM call timed out after ${resolved.timeout}ms`,
          error,
        );
      }
      throw new LLMInvocationError(
        `LLM structured generation failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      abortController?.abort();
    }
  }

  /**
   * Resolve the effective configuration by merging defaults, call-site overrides,
   * and per-invocation option overrides.
   */
  private resolveConfig(options?: InvokeOptions): ResolvedLLMConfig {
    const resolved = resolveCallSiteConfig(this.config, options?.callSite);

    // Apply per-invocation overrides from InvokeOptions on top of resolved config
    if (options?.model !== undefined) {
      resolved.model = options.model;
    }
    if (options?.temperature !== undefined) {
      resolved.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      resolved.maxTokens = options.maxTokens;
    }
    if (options?.timeout !== undefined) {
      resolved.timeout = options.timeout;
    }

    return resolved;
  }

  /**
   * Create an AbortController that auto-aborts after the given timeout.
   * Returns undefined if no timeout is configured.
   */
  private createAbortController(
    timeout?: number,
  ): AbortController | undefined {
    if (!timeout || timeout <= 0) {
      return undefined;
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeout);
    return controller;
  }

  /**
   * Check if an error is an abort/timeout error.
   */
  private isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return true;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return true;
    }
    return false;
  }
}

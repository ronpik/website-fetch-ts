import type { ZodSchema } from 'zod';

/**
 * Known LLM call site keys used throughout the system.
 * Each call site can have its own LLM configuration overrides.
 */
export type LLMCallSiteKey =
  | 'link-classifier'
  | 'conversion-strategy-selector'
  | 'conversion-optimizer'
  | 'agent-router'
  | 'page-summarizer'
  | 'index-generator'
  | 'link-classifier-per-link';

/**
 * Options passed to LLM invocation calls.
 */
export interface InvokeOptions {
  callSite?: LLMCallSiteKey;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

/**
 * Per-call-site LLM configuration overrides.
 */
export interface LLMCallSiteConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  maxRetries?: number;
}

/**
 * LLM configuration with global defaults and optional per-call-site overrides.
 */
export interface LLMConfig {
  defaults: {
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    maxRetries?: number;
  };
  callSites?: {
    [key in LLMCallSiteKey]?: Partial<LLMCallSiteConfig>;
  };
}

/**
 * Interface for LLM providers. Consumers implement this to integrate
 * their preferred LLM service.
 */
export interface LLMProvider {
  invoke(prompt: string, options?: InvokeOptions): Promise<string>;
  invokeStructured<T>(prompt: string, schema: ZodSchema<T>, options?: InvokeOptions): Promise<T>;
}

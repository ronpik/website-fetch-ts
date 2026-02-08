import type { LLMConfig, LLMCallSiteConfig, LLMCallSiteKey } from './types.js';

/**
 * Resolved configuration for a single LLM call, with all fields populated.
 */
export interface ResolvedLLMConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Default LLM configuration used when no config is provided.
 * Uses Anthropic Claude Haiku as the default model with sensible defaults.
 */
export const DEFAULT_LLM_CONFIG: LLMConfig = {
  defaults: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    temperature: 0,
    maxTokens: 4096,
    timeout: 30_000,
    maxRetries: 2,
  },
};

/**
 * Resolve the effective LLM configuration for a given call site.
 *
 * Merges the global defaults from `config.defaults` with any call-site-specific
 * overrides found in `config.callSites[callSite]`. If `callSite` is not provided
 * or is not found in `config.callSites`, the defaults are returned unchanged.
 *
 * @param config - The full LLM configuration with defaults and optional call-site overrides
 * @param callSite - Optional call site key to look up overrides for
 * @returns The resolved configuration with all applicable overrides applied
 */
export function resolveCallSiteConfig(
  config: LLMConfig,
  callSite?: LLMCallSiteKey,
): ResolvedLLMConfig {
  const { defaults } = config;

  const resolved: ResolvedLLMConfig = {
    provider: defaults.provider,
    model: defaults.model,
    temperature: defaults.temperature,
    maxTokens: defaults.maxTokens,
    timeout: defaults.timeout,
    maxRetries: defaults.maxRetries,
  };

  if (!callSite || !config.callSites) {
    return resolved;
  }

  const overrides: Partial<LLMCallSiteConfig> | undefined =
    config.callSites[callSite];

  if (!overrides) {
    return resolved;
  }

  // Merge call-site overrides on top of defaults (only override defined fields)
  if (overrides.model !== undefined) {
    resolved.model = overrides.model;
  }
  if (overrides.temperature !== undefined) {
    resolved.temperature = overrides.temperature;
  }
  if (overrides.maxTokens !== undefined) {
    resolved.maxTokens = overrides.maxTokens;
  }
  if (overrides.timeout !== undefined) {
    resolved.timeout = overrides.timeout;
  }
  if (overrides.maxRetries !== undefined) {
    resolved.maxRetries = overrides.maxRetries;
  }

  return resolved;
}

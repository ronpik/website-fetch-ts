import type { LLMConfig, LLMProvider } from './types.js';
import { DefaultLLMProvider } from './provider.js';
import { DEFAULT_LLM_CONFIG } from './config.js';

/**
 * Create an LLMProvider instance with the given configuration.
 *
 * If no configuration is provided, sensible defaults are used
 * (Anthropic Claude Haiku with standard settings).
 *
 * This is the public factory function for obtaining an LLM provider.
 * Users should not instantiate DefaultLLMProvider directly.
 *
 * @param config - Optional LLM configuration with defaults and call-site overrides
 * @returns An LLMProvider instance ready for use
 */
export function createLLMProvider(config?: LLMConfig): LLMProvider {
  const effectiveConfig = config ?? DEFAULT_LLM_CONFIG;
  return new DefaultLLMProvider(effectiveConfig);
}

// Re-export types for consumer convenience
export type {
  LLMProvider,
  LLMConfig,
  LLMCallSiteConfig,
  LLMCallSiteKey,
  InvokeOptions,
} from './types.js';

// Re-export config utilities
export { resolveCallSiteConfig, DEFAULT_LLM_CONFIG } from './config.js';
export type { ResolvedLLMConfig } from './config.js';

// Re-export provider utilities and errors
export { DefaultLLMProvider, getModel, UnsupportedProviderError, LLMInvocationError } from './provider.js';

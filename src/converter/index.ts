import type { WebsiteFetchConfig } from '../types.js';
import type { LLMProvider } from '../llm/types.js';
import { getStrategy } from './strategies/index.js';
import { selectStrategy } from './strategy-selector.js';
import { optimizeConversion } from './optimizer.js';

export type { ConversionStrategy } from './strategies/index.js';
export {
  DefaultStrategy,
  ReadabilityStrategy,
  CustomStrategy,
  createTurndownService,
  getStrategy,
} from './strategies/index.js';
export { selectStrategy } from './strategy-selector.js';
export { optimizeConversion } from './optimizer.js';

/**
 * Converter object returned by `createConverter`.
 *
 * Provides a single `convert` method that transforms HTML into markdown
 * using the configured conversion strategy.
 */
export interface Converter {
  convert(html: string, url: string): Promise<string>;
}

/**
 * Mode defaults for the conversion pipeline layers.
 *
 * | Mode   | Layer 1 (base strategy) | Layer 2 (strategy selector) | Layer 3 (optimizer) |
 * |--------|-------------------------|-----------------------------|---------------------|
 * | Simple | default                 | off                         | off                 |
 * | Smart  | readability             | on                          | off                 |
 * | Agent  | readability             | on                          | on                  |
 */
const MODE_DEFAULTS: Record<
  'simple' | 'smart' | 'agent',
  {
    defaultStrategy: 'default' | 'readability';
    useStrategySelector: boolean;
    useOptimizer: boolean;
  }
> = {
  simple: {
    defaultStrategy: 'default',
    useStrategySelector: false,
    useOptimizer: false,
  },
  smart: {
    defaultStrategy: 'readability',
    useStrategySelector: true,
    useOptimizer: false,
  },
  agent: {
    defaultStrategy: 'readability',
    useStrategySelector: true,
    useOptimizer: true,
  },
};

/**
 * Create a converter with the specified conversion strategy and optional
 * LLM-powered layers.
 *
 * The converter implements a multi-layer pipeline:
 * - **Layer 1**: Base HTML-to-markdown conversion using the configured strategy
 * - **Layer 2**: LLM-based strategy selection (smart and agent modes)
 * - **Layer 3**: LLM-based conversion optimization loop (agent mode)
 *
 * The active layers depend on the `mode` field in the config and whether an
 * `llmProvider` is available. Without an LLM provider, only Layer 1 runs.
 *
 * @param config - The website-fetch configuration
 * @returns A Converter object with a `convert(html, url)` method
 */
export function createConverter(config: WebsiteFetchConfig): Converter {
  const mode = config.mode ?? 'simple';
  const modeDefaults = MODE_DEFAULTS[mode];
  const llm = config.llmProvider;

  // If conversionStrategy is 'custom', use it directly (bypass Layer 2)
  const isCustomStrategy = config.conversionStrategy === 'custom';

  return {
    async convert(html: string, url: string): Promise<string> {
      // Determine which strategy to use
      let strategyName: 'default' | 'readability' | 'custom';

      if (isCustomStrategy) {
        // Custom strategy bypasses Layer 2 entirely
        strategyName = 'custom';
      } else if (modeDefaults.useStrategySelector && llm) {
        // Layer 2: LLM selects the best strategy
        strategyName = await selectStrategy(
          html,
          url,
          llm,
          modeDefaults.defaultStrategy,
        );
      } else {
        // Use the mode's default strategy, or the explicitly configured one
        strategyName = config.conversionStrategy !== 'custom'
          ? config.conversionStrategy
          : modeDefaults.defaultStrategy;
      }

      // Layer 1: Base conversion with the selected strategy
      const strategy = getStrategy(strategyName, config.customConverter);
      let markdown = await strategy.convert(html, url);

      // Layer 3: LLM optimization loop
      const shouldOptimize =
        (modeDefaults.useOptimizer || config.optimizeConversion) && llm;

      if (shouldOptimize) {
        markdown = await optimizeConversion(html, markdown, url, llm);
      }

      return markdown;
    },
  };
}

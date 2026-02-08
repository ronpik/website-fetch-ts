import { DefaultStrategy } from './default.js';
import { ReadabilityStrategy } from './readability.js';
import { CustomStrategy } from './custom.js';

/**
 * Conversion strategy interface.
 *
 * All strategies implement this interface, allowing them to be used
 * interchangeably in the conversion pipeline.
 */
export interface ConversionStrategy {
  convert(html: string, url: string): Promise<string>;
}

export { DefaultStrategy, createTurndownService } from './default.js';
export { ReadabilityStrategy } from './readability.js';
export { CustomStrategy } from './custom.js';

/**
 * Resolve a ConversionStrategy instance based on the strategy name.
 *
 * @param strategy - The strategy name ('default', 'readability', or 'custom')
 * @param customConverter - Required when strategy is 'custom'; the user-provided converter function
 * @returns A ConversionStrategy instance
 * @throws Error if 'custom' is selected without providing a customConverter function
 */
export function getStrategy(
  strategy: 'default' | 'readability' | 'custom',
  customConverter?: (html: string, url: string) => Promise<string>,
): ConversionStrategy {
  switch (strategy) {
    case 'default':
      return new DefaultStrategy();
    case 'readability':
      return new ReadabilityStrategy();
    case 'custom': {
      if (!customConverter) {
        throw new Error(
          'Custom conversion strategy requires a customConverter function in config',
        );
      }
      return new CustomStrategy(customConverter);
    }
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unknown conversion strategy: ${_exhaustive}`);
    }
  }
}

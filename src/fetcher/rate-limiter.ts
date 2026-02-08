import type { FetchError } from './index.js';

/**
 * Configuration for the AdaptiveRateLimiter.
 */
export interface RateLimiterConfig {
  /** Base delay between requests in milliseconds. */
  delay: number;
  /** Maximum number of retries for 5xx errors. */
  maxRetries: number;
  /** Whether to dynamically adjust delay based on server responses. */
  adaptiveRateLimit: boolean;
}

/**
 * Number of consecutive successes required before reducing delay.
 */
const SUCCESS_THRESHOLD = 10;

/**
 * Multiplier applied to delay on recovery (reduce by 20%).
 */
const RECOVERY_MULTIPLIER = 0.8;

/**
 * Adaptive rate limiter that adjusts request delay based on server responses.
 *
 * - On 429: doubles delay, or uses Retry-After header value
 * - On 5xx: exponential backoff with retry, up to maxRetries
 * - On sustained success (10 consecutive): gradually reduces delay (x0.8),
 *   never below the baseline
 * - When adaptiveRateLimit is false, delay is fixed
 */
export class AdaptiveRateLimiter {
  private currentDelay: number;
  private baselineDelay: number;
  private consecutiveSuccesses: number;
  private readonly maxRetries: number;
  private readonly adaptive: boolean;

  constructor(config: RateLimiterConfig) {
    this.baselineDelay = config.delay;
    this.currentDelay = config.delay;
    this.consecutiveSuccesses = 0;
    this.maxRetries = config.maxRetries;
    this.adaptive = config.adaptiveRateLimit;
  }

  /**
   * Set a minimum floor for the baseline delay (e.g., from robots.txt crawl-delay).
   * If the crawl-delay is higher than the current baseline, both baseline and
   * current delay are raised to that floor.
   *
   * @param delayMs - Minimum delay in milliseconds
   */
  setCrawlDelayFloor(delayMs: number): void {
    if (delayMs > this.baselineDelay) {
      this.baselineDelay = delayMs;
      if (this.currentDelay < this.baselineDelay) {
        this.currentDelay = this.baselineDelay;
      }
    }
  }

  /**
   * Execute a function with rate limiting applied.
   * Waits for the current delay before executing, then adapts delay based on result.
   *
   * For 5xx errors, retries with exponential backoff up to maxRetries.
   * For 429 errors, adjusts delay and re-throws (caller should re-queue).
   * For other errors, re-throws immediately.
   *
   * @param fn - The async function to execute (typically a fetch call)
   * @returns The result of fn
   */
  async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.wait();

    // For 5xx errors, we retry with exponential backoff
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.onSuccess();
        return result;
      } catch (error) {
        const fetchError = error as FetchError;
        const statusCode = fetchError.statusCode;

        if (statusCode === 429) {
          this.on429(fetchError);
          throw error;
        }

        if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
          lastError = fetchError;
          if (attempt < this.maxRetries) {
            // Exponential backoff: delay * 2^attempt
            const backoffDelay = this.currentDelay * Math.pow(2, attempt + 1);
            await this.sleep(backoffDelay);
            this.consecutiveSuccesses = 0;
            continue;
          }
          // Max retries exhausted
          throw error;
        }

        // Non-retryable error (4xx other than 429, network errors, etc.)
        throw error;
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw lastError;
  }

  /**
   * Get the current delay value (for testing/inspection).
   */
  getCurrentDelay(): number {
    return this.currentDelay;
  }

  /**
   * Get the baseline delay value (for testing/inspection).
   */
  getBaselineDelay(): number {
    return this.baselineDelay;
  }

  /**
   * Wait for the current delay period.
   */
  private async wait(): Promise<void> {
    if (this.currentDelay > 0) {
      await this.sleep(this.currentDelay);
    }
  }

  /**
   * Handle a successful response. After 10 consecutive successes,
   * reduce the delay by 20% (but never below baseline).
   */
  private onSuccess(): void {
    if (!this.adaptive) {
      return;
    }

    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= SUCCESS_THRESHOLD) {
      this.currentDelay = Math.max(
        this.baselineDelay,
        this.currentDelay * RECOVERY_MULTIPLIER,
      );
      this.consecutiveSuccesses = 0;
    }
  }

  /**
   * Handle a 429 Too Many Requests response.
   * Uses the Retry-After header if present, otherwise doubles the delay.
   */
  private on429(error: FetchError): void {
    this.consecutiveSuccesses = 0;

    if (!this.adaptive) {
      return;
    }

    const retryAfter = error.headers?.['retry-after'];
    if (retryAfter) {
      const parsed = parseRetryAfter(retryAfter);
      if (parsed !== undefined) {
        this.currentDelay = parsed;
        return;
      }
    }

    // Default: double the current delay
    this.currentDelay = this.currentDelay * 2;
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Parse a Retry-After header value.
 * Can be either a number of seconds or an HTTP-date string.
 *
 * @param value - The Retry-After header value
 * @returns Delay in milliseconds, or undefined if unparseable
 */
export function parseRetryAfter(value: string): number | undefined {
  // Try parsing as a number of seconds first
  const seconds = Number(value);
  if (!isNaN(seconds) && isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try parsing as an HTTP-date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    // If the date is in the past, use 0
    return Math.max(0, delayMs);
  }

  return undefined;
}

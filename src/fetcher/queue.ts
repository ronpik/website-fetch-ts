import PQueue from 'p-queue';
import { AdaptiveRateLimiter, type RateLimiterConfig } from './rate-limiter.js';

/**
 * Configuration for the FetchQueue.
 */
export interface FetchQueueConfig extends RateLimiterConfig {
  /** Maximum number of concurrent requests. */
  concurrency: number;
}

/**
 * Queue that wraps p-queue with adaptive rate limiting.
 * All fetch requests should go through this queue to enforce
 * concurrency limits and per-request rate limiting.
 */
export class FetchQueue {
  private readonly queue: PQueue;
  readonly rateLimiter: AdaptiveRateLimiter;

  constructor(config: FetchQueueConfig) {
    this.queue = new PQueue({ concurrency: config.concurrency });
    this.rateLimiter = new AdaptiveRateLimiter({
      delay: config.delay,
      maxRetries: config.maxRetries,
      adaptiveRateLimit: config.adaptiveRateLimit,
    });
  }

  /**
   * Add an async function to the queue. The function will be executed
   * with rate limiting applied (wait before execution, adapt on response).
   *
   * @param fn - The async function to execute
   * @returns The result of fn
   */
  async add<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.queue.add(() =>
      this.rateLimiter.executeWithRateLimit(fn),
    );
    return result as T;
  }

  /**
   * Get the number of pending items in the queue.
   */
  get pending(): number {
    return this.queue.pending;
  }

  /**
   * Get the queue size (waiting items, not yet started).
   */
  get size(): number {
    return this.queue.size;
  }

  /**
   * Wait for the queue to be idle (all items processed).
   */
  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  /**
   * Clear the queue (remove pending items that haven't started).
   */
  clear(): void {
    this.queue.clear();
  }
}

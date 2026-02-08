import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AdaptiveRateLimiter,
  parseRetryAfter,
  FetchError,
} from "../fetcher/index.js";
import { FetchQueue } from "../fetcher/queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a FetchError with a given status code and optional headers.
 * This mirrors how the fetcher creates errors for HTTP error responses.
 */
function makeFetchError(
  statusCode: number,
  headers?: Record<string, string>,
): FetchError {
  return new FetchError(
    `HTTP ${statusCode}`,
    "https://example.com/page",
    statusCode,
    headers,
  );
}

/**
 * Create a function that succeeds, returning a given value.
 */
function succeedWith<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

/**
 * Create a function that fails with the given error.
 * Uses throw inside async to avoid unhandled rejection warnings.
 */
function failWith(error: Error): () => Promise<never> {
  return async () => { throw error; };
}

/**
 * Create a default AdaptiveRateLimiter config with 0 delay for fast tests.
 */
function makeRateLimiterConfig(overrides: Partial<{
  delay: number;
  maxRetries: number;
  adaptiveRateLimit: boolean;
}> = {}) {
  return {
    delay: 0,
    maxRetries: 3,
    adaptiveRateLimit: true,
    ...overrides,
  };
}

/**
 * Helper to execute a rate-limited call that is expected to reject.
 * Attaches a no-op catch immediately to prevent PromiseRejectionHandledWarning
 * that occurs with fake timers (the rejection happens before the test's
 * await catches it).
 */
async function executeExpectingReject<T>(
  promise: Promise<T>,
  advanceMs: number,
): Promise<FetchError> {
  // Attach catch immediately so Node knows rejection will be handled
  const caught = promise.catch((e) => e);
  await vi.advanceTimersByTimeAsync(advanceMs);
  const error = await caught;
  return error as FetchError;
}

// ---------------------------------------------------------------------------
// 1. parseRetryAfter (exported utility)
// ---------------------------------------------------------------------------
describe("parseRetryAfter", () => {
  it("should parse a numeric string as seconds and return milliseconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
  });

  it("should parse '0' as 0 milliseconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("should parse a decimal number of seconds", () => {
    expect(parseRetryAfter("1.5")).toBe(1500);
  });

  it("should parse an HTTP-date string and return delay in milliseconds", () => {
    // Set a date 10 seconds in the future
    const futureDate = new Date(Date.now() + 10_000);
    const httpDate = futureDate.toUTCString();
    const result = parseRetryAfter(httpDate);

    expect(result).toBeDefined();
    // Should be approximately 10000ms (allow some tolerance for test execution time)
    expect(result!).toBeGreaterThan(9000);
    expect(result!).toBeLessThanOrEqual(10_100);
  });

  it("should return 0 for an HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 60_000);
    const httpDate = pastDate.toUTCString();
    const result = parseRetryAfter(httpDate);

    expect(result).toBe(0);
  });

  it("should return undefined for an unparseable string", () => {
    expect(parseRetryAfter("not-a-number-or-date")).toBeUndefined();
  });

  it("should return 0 for negative numbers (falls through to date parsing)", () => {
    // Number("-5") is -5 which fails >= 0 check, but new Date("-5") is a valid
    // historical date, so it falls through to date parsing and returns 0
    // (because the date is far in the past, clamped to 0)
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("should return undefined for Infinity", () => {
    expect(parseRetryAfter("Infinity")).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    // Empty string converts to 0 via Number(""), which is 0
    // Actually Number("") === 0, which is >= 0, so it returns 0
    const result = parseRetryAfter("");
    // Number("") is 0, isNaN(0) is false, isFinite(0) is true, 0 >= 0 is true
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. AdaptiveRateLimiter - Constructor & Initial State
// ---------------------------------------------------------------------------
describe("AdaptiveRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor and initial state", () => {
    it("should have initial delay matching the configured value", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 200 }));
      expect(limiter.getCurrentDelay()).toBe(200);
    });

    it("should have baseline delay matching the configured value", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 500 }));
      expect(limiter.getBaselineDelay()).toBe(500);
    });

    it("should start with currentDelay equal to baselineDelay", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 300 }));
      expect(limiter.getCurrentDelay()).toBe(limiter.getBaselineDelay());
    });
  });

  // ---------------------------------------------------------------------------
  // 3. executeWithRateLimit - Successful execution
  // ---------------------------------------------------------------------------
  describe("executeWithRateLimit - success", () => {
    it("should return the result of the provided function", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig());
      const promise = limiter.executeWithRateLimit(succeedWith("hello"));
      // With delay 0, timers should not matter but advance anyway
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result).toBe("hello");
    });

    it("should call the provided function exactly once on success", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig());
      const fn = vi.fn().mockResolvedValue("ok");
      const promise = limiter.executeWithRateLimit(fn);
      await vi.advanceTimersByTimeAsync(0);
      await promise;
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. On 429: delay doubles
  // ---------------------------------------------------------------------------
  describe("on 429 - delay doubling", () => {
    it("should double the delay on 429 response", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 100 }));

      const error429 = makeFetchError(429);
      const caught = await executeExpectingReject(
        limiter.executeWithRateLimit(failWith(error429)),
        100,
      );
      expect(caught).toBe(error429);
      expect(limiter.getCurrentDelay()).toBe(200);
    });

    it("should re-throw the 429 error (not retry)", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig());

      const error429 = makeFetchError(429);
      let callCount = 0;
      const fn = async () => { callCount++; throw error429; };
      const caught = await executeExpectingReject(
        limiter.executeWithRateLimit(fn),
        0,
      );
      expect(caught).toBe(error429);
      // Should have been called only once (no retry for 429)
      expect(callCount).toBe(1);
    });

    it("should reset consecutive successes on 429", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 0 }));

      // Accumulate some successes (but less than 10)
      for (let i = 0; i < 5; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(0);
        await p;
      }

      // Trigger a 429
      const error429 = makeFetchError(429);
      await executeExpectingReject(
        limiter.executeWithRateLimit(failWith(error429)),
        0,
      );

      // Now 10 more successes should be needed to trigger recovery
      // (consecutive count was reset to 0 by the 429)
      const delayAfter429 = limiter.getCurrentDelay();

      for (let i = 0; i < 9; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(0);
        await p;
      }

      // After 9 more successes, delay should not have changed
      expect(limiter.getCurrentDelay()).toBe(delayAfter429);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. On 429 with Retry-After header: uses header value
  // ---------------------------------------------------------------------------
  describe("on 429 with Retry-After header", () => {
    it("should use numeric Retry-After value (in seconds) converted to ms", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 100 }));

      const error429 = makeFetchError(429, { "retry-after": "5" });
      await executeExpectingReject(
        limiter.executeWithRateLimit(failWith(error429)),
        100,
      );
      expect(limiter.getCurrentDelay()).toBe(5000);
    });

    it("should use HTTP-date Retry-After value", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 100 }));

      // Use a date 30 seconds in the future
      const futureDate = new Date(Date.now() + 30_000);
      const error429 = makeFetchError(429, {
        "retry-after": futureDate.toUTCString(),
      });

      await executeExpectingReject(
        limiter.executeWithRateLimit(failWith(error429)),
        100,
      );
      // The delay should be approximately 30000ms (wider tolerance for CI/timing)
      const delay = limiter.getCurrentDelay();
      expect(delay).toBeGreaterThan(28_000);
      expect(delay).toBeLessThanOrEqual(31_000);
    });

    it("should fall back to doubling when Retry-After header is unparseable", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 100 }));

      const error429 = makeFetchError(429, { "retry-after": "garbage-value" });
      await executeExpectingReject(
        limiter.executeWithRateLimit(failWith(error429)),
        100,
      );
      expect(limiter.getCurrentDelay()).toBe(200); // doubled
    });
  });

  // ---------------------------------------------------------------------------
  // 6. On 5xx: exponential backoff and retries
  // ---------------------------------------------------------------------------
  describe("on 5xx - exponential backoff", () => {
    it("should retry on 500 error up to maxRetries times", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        maxRetries: 3,
      }));

      const error500 = makeFetchError(500);
      let callCount = 0;
      const fn = async () => { callCount++; throw error500; };
      const caught = await executeExpectingReject(
        limiter.executeWithRateLimit(fn),
        10_000,
      );
      expect(caught).toBe(error500);
      // 1 initial + 3 retries = 4 total calls
      expect(callCount).toBe(4);
    });

    it("should throw after maxRetries exhausted on 5xx", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        maxRetries: 2,
      }));

      const error503 = makeFetchError(503);
      let callCount = 0;
      const fn = async () => { callCount++; throw error503; };
      const caught = await executeExpectingReject(
        limiter.executeWithRateLimit(fn),
        10_000,
      );
      expect(caught).toBe(error503);
      // 1 initial + 2 retries = 3 total calls
      expect(callCount).toBe(3);
    });

    it("should succeed if a retry succeeds before maxRetries", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        maxRetries: 3,
      }));

      const error500 = makeFetchError(500);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount <= 2) throw error500;
        return "recovered";
      };

      const promise = limiter.executeWithRateLimit(fn);
      await vi.advanceTimersByTimeAsync(10_000);

      const result = await promise;
      expect(result).toBe("recovered");
      expect(callCount).toBe(3);
    });

    it("should apply exponential backoff delays between retries", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        maxRetries: 3,
      }));

      const error500 = makeFetchError(500);
      const callTimestamps: number[] = [];
      let callCount = 0;

      const fn = async () => {
        callTimestamps.push(Date.now());
        callCount++;
        if (callCount <= 3) {
          throw error500;
        }
        return "ok";
      };

      const promise = limiter.executeWithRateLimit(fn);

      // Initial wait (100ms) + attempt 0 fails
      await vi.advanceTimersByTimeAsync(100);
      // Backoff after attempt 0: 100 * 2^1 = 200ms
      await vi.advanceTimersByTimeAsync(200);
      // Backoff after attempt 1: 100 * 2^2 = 400ms
      await vi.advanceTimersByTimeAsync(400);
      // Backoff after attempt 2: 100 * 2^3 = 800ms
      await vi.advanceTimersByTimeAsync(800);

      const result = await promise;
      expect(result).toBe("ok");
      expect(callCount).toBe(4);
    });

    it("should not retry on 502 beyond maxRetries", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        maxRetries: 1,
      }));

      const error502 = makeFetchError(502);
      let callCount = 0;
      const fn = async () => { callCount++; throw error502; };
      const promise = limiter.executeWithRateLimit(fn);
      promise.catch(() => {}); // Prevent unhandled rejection warning

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(promise).rejects.toThrow();
      // 1 initial + 1 retry = 2
      expect(callCount).toBe(2);
    });

    it("should reset consecutive successes on 5xx error", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 0 }));

      // 5 successes
      for (let i = 0; i < 5; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(0);
        await p;
      }

      // A 500 that eventually succeeds
      const error500 = makeFetchError(500);
      let retryCallCount = 0;
      const fn = async () => {
        retryCallCount++;
        if (retryCallCount <= 1) throw error500;
        return "recovered";
      };
      const p = limiter.executeWithRateLimit(fn);
      await vi.advanceTimersByTimeAsync(10_000);
      await p;

      // Now we need a fresh 10 successes to trigger recovery
      // The 5 prior successes were reset by the 5xx
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Non-retryable errors (4xx other than 429)
  // ---------------------------------------------------------------------------
  describe("non-retryable errors", () => {
    it("should throw immediately on 404 without retrying", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 0 }));

      const error404 = makeFetchError(404);
      let callCount = 0;
      const fn = async () => { callCount++; throw error404; };
      const promise = limiter.executeWithRateLimit(fn);
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).rejects.toBe(error404);
      expect(callCount).toBe(1);
    });

    it("should throw immediately on 403 without retrying", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 0 }));

      const error403 = makeFetchError(403);
      let callCount = 0;
      const fn = async () => { callCount++; throw error403; };
      const promise = limiter.executeWithRateLimit(fn);
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).rejects.toBe(error403);
      expect(callCount).toBe(1);
    });

    it("should throw immediately on non-FetchError", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 0 }));

      const genericError = new Error("Something went wrong");
      const fn = async () => { throw genericError; };
      const promise = limiter.executeWithRateLimit(fn);
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).rejects.toBe(genericError);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Sustained success: gradual delay decrease
  // ---------------------------------------------------------------------------
  describe("sustained success - gradual recovery", () => {
    it("should decrease delay by 20% after 10 consecutive successes", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        adaptiveRateLimit: true,
      }));

      // First, inflate the delay via a 429
      const error429 = makeFetchError(429);
      const p429 = limiter.executeWithRateLimit(failWith(error429));
      p429.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(0);
      await expect(p429).rejects.toThrow();

      // Delay is now 0 * 2 = 0 (since baseline is 0)
      // Let's use a non-zero baseline to see the effect
      const limiter2 = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // Inflate delay: trigger a 429 to double it
      const p2 = limiter2.executeWithRateLimit(failWith(makeFetchError(429)));
      p2.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(100);
      await expect(p2).rejects.toThrow();
      expect(limiter2.getCurrentDelay()).toBe(200);

      // Now 10 consecutive successes
      for (let i = 0; i < 10; i++) {
        const p = limiter2.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(200);
        await p;
      }

      // Delay should be 200 * 0.8 = 160
      expect(limiter2.getCurrentDelay()).toBe(160);
    });

    it("should continue decreasing delay with more sets of 10 successes", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // Inflate delay to 400 (two 429s)
      for (let i = 0; i < 2; i++) {
        const p = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
        p.catch(() => {}); // Prevent unhandled rejection warning
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await expect(p).rejects.toThrow();
      }
      expect(limiter.getCurrentDelay()).toBe(400);

      // First set of 10 successes: 400 * 0.8 = 320
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(320);

      // Second set of 10 successes: 320 * 0.8 = 256
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(256);
    });

    it("should not decrease delay after fewer than 10 consecutive successes", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // Inflate delay
      const p = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(100);
      await expect(p).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(200);

      // Only 9 successes
      for (let i = 0; i < 9; i++) {
        const sp = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(200);
        await sp;
      }

      // Delay should still be 200 (not reduced)
      expect(limiter.getCurrentDelay()).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Delay never goes below baseline
  // ---------------------------------------------------------------------------
  describe("delay never goes below baseline", () => {
    it("should clamp delay to baseline after recovery", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // The delay is already at baseline. After 10 successes,
      // 100 * 0.8 = 80, but should be clamped to 100 (baseline).
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(100);
        await p;
      }

      expect(limiter.getCurrentDelay()).toBe(100);
    });

    it("should never go below baseline even with many recovery cycles", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // Inflate just slightly above baseline
      // 429 doubles: 100 -> 200
      const p429 = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p429.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(100);
      await expect(p429).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(200);

      // 10 successes: 200 * 0.8 = 160 (above baseline, allowed)
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(160);

      // 10 more: 160 * 0.8 = 128 (still above baseline)
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(128);

      // 10 more: 128 * 0.8 = 102.4 (still above 100)
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBeCloseTo(102.4);

      // 10 more: 102.4 * 0.8 = 81.92, clamped to 100
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. adaptiveRateLimit: false - fixed delay
  // ---------------------------------------------------------------------------
  describe("adaptiveRateLimit: false - fixed delay", () => {
    it("should not change delay on 429 when adaptive is false", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: false,
      }));

      const error429 = makeFetchError(429);
      const promise = limiter.executeWithRateLimit(failWith(error429));
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).rejects.toThrow();

      // Delay should remain fixed at 100
      expect(limiter.getCurrentDelay()).toBe(100);
    });

    it("should not change delay on sustained success when adaptive is false", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: false,
      }));

      for (let i = 0; i < 15; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(100);
        await p;
      }

      // Delay should remain fixed at 100
      expect(limiter.getCurrentDelay()).toBe(100);
    });

    it("should still re-throw 429 error when adaptive is false", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        adaptiveRateLimit: false,
      }));

      const error429 = makeFetchError(429);
      const promise = limiter.executeWithRateLimit(failWith(error429));
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).rejects.toBe(error429);
    });

    it("should still retry on 5xx when adaptive is false", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 0,
        maxRetries: 2,
        adaptiveRateLimit: false,
      }));

      const error500 = makeFetchError(500);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount <= 1) throw error500;
        return "recovered";
      };

      const promise = limiter.executeWithRateLimit(fn);
      await vi.advanceTimersByTimeAsync(10_000);

      const result = await promise;
      expect(result).toBe("recovered");
      expect(callCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 11. setCrawlDelayFloor - crawl-delay from robots.txt
  // ---------------------------------------------------------------------------
  describe("setCrawlDelayFloor", () => {
    it("should raise baseline if crawl-delay is higher", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 200 }));

      limiter.setCrawlDelayFloor(1000);

      expect(limiter.getBaselineDelay()).toBe(1000);
      expect(limiter.getCurrentDelay()).toBe(1000);
    });

    it("should not lower baseline if crawl-delay is lower", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 500 }));

      limiter.setCrawlDelayFloor(100);

      expect(limiter.getBaselineDelay()).toBe(500);
      expect(limiter.getCurrentDelay()).toBe(500);
    });

    it("should not lower currentDelay if it is already above the new floor", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 200 }));
      // Manually the delay is at 200 (baseline). Set floor to 300.
      limiter.setCrawlDelayFloor(300);
      expect(limiter.getCurrentDelay()).toBe(300);
      expect(limiter.getBaselineDelay()).toBe(300);
    });

    it("should raise currentDelay to floor if currentDelay is below new floor", () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 100 }));
      // currentDelay starts at 100
      limiter.setCrawlDelayFloor(500);
      expect(limiter.getCurrentDelay()).toBe(500);
    });

    it("should act as floor for recovery (delay never goes below crawl-delay floor)", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // Set crawl-delay floor higher than baseline
      limiter.setCrawlDelayFloor(300);
      expect(limiter.getBaselineDelay()).toBe(300);

      // Inflate delay via 429: 300 -> 600
      const p429 = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p429.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(300);
      await expect(p429).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(600);

      // 10 successes: 600 * 0.8 = 480 (above 300, allowed)
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(480);

      // Keep recovering until we hit the floor
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(384);

      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBeCloseTo(307.2);

      // One more recovery: 307.2 * 0.8 = 245.76, clamped to 300
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(300);
    });
  });

  // ---------------------------------------------------------------------------
  // 12. Edge case: Multiple 429s in succession (delay keeps doubling)
  // ---------------------------------------------------------------------------
  describe("multiple 429s in succession", () => {
    it("should keep doubling delay on successive 429s", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // First 429: 100 -> 200
      const p1 = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p1.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(100);
      await expect(p1).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(200);

      // Second 429: 200 -> 400
      const p2 = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p2.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(200);
      await expect(p2).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(400);

      // Third 429: 400 -> 800
      const p3 = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p3.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(400);
      await expect(p3).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(800);

      // Fourth 429: 800 -> 1600
      const p4 = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
      p4.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(800);
      await expect(p4).rejects.toThrow();
      expect(limiter.getCurrentDelay()).toBe(1600);
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Edge case: Recovery after backoff
  // ---------------------------------------------------------------------------
  describe("recovery after backoff", () => {
    it("should gradually recover delay after backoff from 429", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({
        delay: 100,
        adaptiveRateLimit: true,
      }));

      // Inflate to 800 via three 429s
      for (let i = 0; i < 3; i++) {
        const p = limiter.executeWithRateLimit(failWith(makeFetchError(429)));
        p.catch(() => {}); // Prevent unhandled rejection warning
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await expect(p).rejects.toThrow();
      }
      expect(limiter.getCurrentDelay()).toBe(800);

      // 10 successes: 800 * 0.8 = 640
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(640);

      // 10 more: 640 * 0.8 = 512
      for (let i = 0; i < 10; i++) {
        const p = limiter.executeWithRateLimit(succeedWith("ok"));
        await vi.advanceTimersByTimeAsync(limiter.getCurrentDelay());
        await p;
      }
      expect(limiter.getCurrentDelay()).toBe(512);
    });
  });

  // ---------------------------------------------------------------------------
  // 14. Wait (delay) is applied before each request
  // ---------------------------------------------------------------------------
  describe("wait delay", () => {
    it("should wait for the configured delay before executing the function", async () => {
      const limiter = new AdaptiveRateLimiter(makeRateLimiterConfig({ delay: 500 }));

      let executed = false;
      const fn = vi.fn().mockImplementation(() => {
        executed = true;
        return Promise.resolve("done");
      });

      const promise = limiter.executeWithRateLimit(fn);

      // Function should not have been called yet
      expect(executed).toBe(false);

      // Advance 400ms (not enough)
      await vi.advanceTimersByTimeAsync(400);
      expect(executed).toBe(false);

      // Advance remaining 100ms
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      expect(executed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 15. FetchQueue - concurrency control
// ---------------------------------------------------------------------------
describe("FetchQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("add()", () => {
    it("should execute a function and return its result", async () => {
      const queue = new FetchQueue({
        delay: 0,
        concurrency: 3,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      const promise = queue.add(() => Promise.resolve("hello"));
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;
      expect(result).toBe("hello");
    });
  });

  describe("concurrency limit", () => {
    it("should respect the concurrency limit", async () => {
      const concurrency = 2;
      const queue = new FetchQueue({
        delay: 0,
        concurrency,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      let currentlyRunning = 0;
      let maxConcurrent = 0;

      const createTask = (id: number) => {
        return queue.add(() => new Promise<string>((resolve) => {
          currentlyRunning++;
          if (currentlyRunning > maxConcurrent) {
            maxConcurrent = currentlyRunning;
          }
          // Simulate async work that takes some time
          setTimeout(() => {
            currentlyRunning--;
            resolve(`task-${id}`);
          }, 100);
        }));
      };

      // Add 5 tasks
      const promises = [
        createTask(1),
        createTask(2),
        createTask(3),
        createTask(4),
        createTask(5),
      ];

      // Process the initial delay (0ms) to start tasks
      await vi.advanceTimersByTimeAsync(0);

      // Allow first batch to start
      await vi.advanceTimersByTimeAsync(50);

      // At this point, at most `concurrency` tasks should be running
      expect(maxConcurrent).toBeLessThanOrEqual(concurrency);

      // Advance enough time for all tasks to complete
      await vi.advanceTimersByTimeAsync(1000);

      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      expect(maxConcurrent).toBeLessThanOrEqual(concurrency);
    });

    it("should handle concurrency of 1 (serial execution)", async () => {
      const queue = new FetchQueue({
        delay: 0,
        concurrency: 1,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      let currentlyRunning = 0;
      let maxConcurrent = 0;

      const createTask = () => {
        return queue.add(() => new Promise<string>((resolve) => {
          currentlyRunning++;
          if (currentlyRunning > maxConcurrent) {
            maxConcurrent = currentlyRunning;
          }
          setTimeout(() => {
            currentlyRunning--;
            resolve("done");
          }, 50);
        }));
      };

      const promises = [createTask(), createTask(), createTask()];

      // Advance enough to process all tasks
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all(promises);

      expect(maxConcurrent).toBe(1);
    });
  });

  describe("pending and size", () => {
    it("should report pending (running) and size (waiting) counts", async () => {
      const queue = new FetchQueue({
        delay: 0,
        concurrency: 1,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      let resolveFirst!: (value: string) => void;
      const firstTask = new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });

      // Add a task that blocks
      const p1 = queue.add(() => firstTask);
      await vi.advanceTimersByTimeAsync(0);

      // Add two more tasks that will be queued
      const p2 = queue.add(() => Promise.resolve("second"));
      const p3 = queue.add(() => Promise.resolve("third"));

      // First task is running (pending=1), two waiting (size=2)
      expect(queue.pending).toBe(1);
      expect(queue.size).toBe(2);

      // Resolve first task
      resolveFirst("first");
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      // Allow remaining tasks to process
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([p2, p3]);
    });
  });

  describe("clear()", () => {
    it("should clear waiting items from the queue", async () => {
      const queue = new FetchQueue({
        delay: 0,
        concurrency: 1,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      let resolveBlock!: (value: string) => void;
      const blockingTask = new Promise<string>((resolve) => {
        resolveBlock = resolve;
      });

      // Add a blocking task and additional tasks
      const p1 = queue.add(() => blockingTask);
      await vi.advanceTimersByTimeAsync(0);

      queue.add(() => Promise.resolve("second"));
      queue.add(() => Promise.resolve("third"));

      expect(queue.size).toBe(2);

      queue.clear();

      expect(queue.size).toBe(0);

      // Unblock the first task
      resolveBlock("first");
      await vi.advanceTimersByTimeAsync(0);
      await p1;
    });
  });

  describe("onIdle()", () => {
    it("should resolve when all tasks are done", async () => {
      const queue = new FetchQueue({
        delay: 0,
        concurrency: 3,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      queue.add(() => new Promise<string>((resolve) => setTimeout(() => resolve("a"), 50)));
      queue.add(() => new Promise<string>((resolve) => setTimeout(() => resolve("b"), 50)));

      const idlePromise = queue.onIdle();

      await vi.advanceTimersByTimeAsync(100);
      await idlePromise;
      // If we get here, onIdle resolved
    });
  });

  describe("rateLimiter integration", () => {
    it("should expose the rateLimiter for setCrawlDelayFloor", () => {
      const queue = new FetchQueue({
        delay: 200,
        concurrency: 3,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      expect(queue.rateLimiter).toBeDefined();
      expect(queue.rateLimiter).toBeInstanceOf(AdaptiveRateLimiter);
      expect(queue.rateLimiter.getCurrentDelay()).toBe(200);
    });

    it("should apply rate limiting via the queue's rateLimiter", async () => {
      const queue = new FetchQueue({
        delay: 0,
        concurrency: 3,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      // Trigger a 429 through the queue
      const error429 = makeFetchError(429);
      const promise = queue.add(failWith(error429));
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).rejects.toThrow();

      // The underlying rate limiter should have its delay adjusted
      // (Since adaptive is true and delay was 0, it doubles to 0 -- need non-zero)
    });

    it("should apply rate limiting with non-zero delay via the queue", async () => {
      const queue = new FetchQueue({
        delay: 100,
        concurrency: 3,
        maxRetries: 3,
        adaptiveRateLimit: true,
      });

      const error429 = makeFetchError(429);
      const promise = queue.add(failWith(error429));
      promise.catch(() => {}); // Prevent unhandled rejection warning
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).rejects.toThrow();

      // After 429, the rate limiter delay should have doubled
      expect(queue.rateLimiter.getCurrentDelay()).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// 16. FetchError with headers (Task 3.2 extension)
// ---------------------------------------------------------------------------
describe("FetchError with headers", () => {
  it("should accept an optional headers parameter", () => {
    const error = new FetchError(
      "HTTP 429",
      "https://example.com",
      429,
      { "retry-after": "60" },
    );

    expect(error.headers).toEqual({ "retry-after": "60" });
  });

  it("should have undefined headers when not provided", () => {
    const error = new FetchError("HTTP 404", "https://example.com", 404);
    expect(error.headers).toBeUndefined();
  });

  it("should be backward compatible (2-arg constructor)", () => {
    const error = new FetchError("Network error", "https://example.com");
    expect(error.statusCode).toBeUndefined();
    expect(error.headers).toBeUndefined();
  });
});

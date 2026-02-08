import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mock the `ai` package (generateText, generateObject)
// ---------------------------------------------------------------------------
const mockGenerateText = vi.fn();
const mockGenerateObject = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  generateObject: (...args: unknown[]) => mockGenerateObject(...args),
}));

// ---------------------------------------------------------------------------
// Mock the `@ai-sdk/anthropic` package
// ---------------------------------------------------------------------------
const mockAnthropicModel = { modelId: 'mock-anthropic-model', provider: 'anthropic' };
const mockCreateAnthropic = vi.fn(() => {
  return (_model: string) => mockAnthropicModel;
});

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: (...args: unknown[]) => mockCreateAnthropic(...args),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks are set up)
// ---------------------------------------------------------------------------
import {
  createLLMProvider,
  resolveCallSiteConfig,
  DEFAULT_LLM_CONFIG,
  DefaultLLMProvider,
  getModel,
  UnsupportedProviderError,
  LLMInvocationError,
} from '../llm/index.js';
import type { LLMConfig, InvokeOptions } from '../llm/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal LLMConfig for testing. */
function makeConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    defaults: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0,
      maxTokens: 4096,
      timeout: 30_000,
      maxRetries: 2,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default success response for generateText
  mockGenerateText.mockResolvedValue({ text: 'Hello from LLM' });
  // Default success response for generateObject
  mockGenerateObject.mockResolvedValue({ object: { name: 'test', value: 42 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Config resolution (pure function tests)
// ===========================================================================
describe('resolveCallSiteConfig', () => {
  describe('defaults used when no call-site override', () => {
    it('should return all defaults when no callSite is provided', () => {
      const config = makeConfig();
      const resolved = resolveCallSiteConfig(config);

      expect(resolved.provider).toBe('anthropic');
      expect(resolved.model).toBe('claude-haiku-4-5-20251001');
      expect(resolved.temperature).toBe(0);
      expect(resolved.maxTokens).toBe(4096);
      expect(resolved.timeout).toBe(30_000);
      expect(resolved.maxRetries).toBe(2);
    });

    it('should return all defaults when callSite is undefined', () => {
      const config = makeConfig();
      const resolved = resolveCallSiteConfig(config, undefined);

      expect(resolved.provider).toBe('anthropic');
      expect(resolved.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('call-site overrides merged correctly', () => {
    it('should override all fields when callSite has full overrides', () => {
      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 4096,
          timeout: 30_000,
          maxRetries: 2,
        },
        callSites: {
          'link-classifier': {
            model: 'claude-sonnet-4-20250514',
            temperature: 0.5,
            maxTokens: 2048,
            timeout: 60_000,
            maxRetries: 5,
          },
        },
      };

      const resolved = resolveCallSiteConfig(config, 'link-classifier');

      expect(resolved.provider).toBe('anthropic'); // provider is not a call-site override field
      expect(resolved.model).toBe('claude-sonnet-4-20250514');
      expect(resolved.temperature).toBe(0.5);
      expect(resolved.maxTokens).toBe(2048);
      expect(resolved.timeout).toBe(60_000);
      expect(resolved.maxRetries).toBe(5);
    });
  });

  describe('partial call-site override only overrides specified fields', () => {
    it('should only override the specified fields, leaving others at defaults', () => {
      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 4096,
          timeout: 30_000,
          maxRetries: 2,
        },
        callSites: {
          'page-summarizer': {
            temperature: 0.7,
            maxTokens: 8192,
          },
        },
      };

      const resolved = resolveCallSiteConfig(config, 'page-summarizer');

      // Overridden
      expect(resolved.temperature).toBe(0.7);
      expect(resolved.maxTokens).toBe(8192);
      // Not overridden -- should remain at defaults
      expect(resolved.provider).toBe('anthropic');
      expect(resolved.model).toBe('claude-haiku-4-5-20251001');
      expect(resolved.timeout).toBe(30_000);
      expect(resolved.maxRetries).toBe(2);
    });
  });

  describe('unknown call site key falls back to defaults', () => {
    it('should return defaults when callSite key is not found in callSites', () => {
      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 4096,
          timeout: 30_000,
          maxRetries: 2,
        },
        callSites: {
          'link-classifier': {
            model: 'claude-sonnet-4-20250514',
          },
        },
      };

      // Use a valid call-site key that is not in the config
      const resolved = resolveCallSiteConfig(config, 'agent-router');

      expect(resolved.provider).toBe('anthropic');
      expect(resolved.model).toBe('claude-haiku-4-5-20251001');
      expect(resolved.temperature).toBe(0);
      expect(resolved.maxTokens).toBe(4096);
      expect(resolved.timeout).toBe(30_000);
      expect(resolved.maxRetries).toBe(2);
    });

    it('should return defaults when callSites is not defined at all', () => {
      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
        },
      };

      const resolved = resolveCallSiteConfig(config, 'link-classifier');

      expect(resolved.provider).toBe('anthropic');
      expect(resolved.model).toBe('claude-haiku-4-5-20251001');
    });
  });
});

// ===========================================================================
// 2. DEFAULT_LLM_CONFIG
// ===========================================================================
describe('DEFAULT_LLM_CONFIG', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_LLM_CONFIG.defaults.provider).toBe('anthropic');
    expect(DEFAULT_LLM_CONFIG.defaults.model).toBe('claude-haiku-4-5-20251001');
    expect(DEFAULT_LLM_CONFIG.defaults.temperature).toBe(0);
    expect(DEFAULT_LLM_CONFIG.defaults.maxTokens).toBe(4096);
    expect(DEFAULT_LLM_CONFIG.defaults.timeout).toBe(30_000);
    expect(DEFAULT_LLM_CONFIG.defaults.maxRetries).toBe(2);
  });
});

// ===========================================================================
// 3. getModel
// ===========================================================================
describe('getModel', () => {
  it('should return a model object for anthropic provider', async () => {
    const model = await getModel('anthropic', 'claude-haiku-4-5-20251001');
    expect(model).toBeDefined();
    expect(mockCreateAnthropic).toHaveBeenCalled();
  });

  it('should throw UnsupportedProviderError for unknown provider string', async () => {
    await expect(getModel('gemini', 'gemini-pro')).rejects.toThrow(
      UnsupportedProviderError,
    );
    await expect(getModel('gemini', 'gemini-pro')).rejects.toThrow(
      /Unsupported LLM provider: "gemini"/,
    );
  });

  it('should throw UnsupportedProviderError for empty provider string', async () => {
    await expect(getModel('', 'some-model')).rejects.toThrow(
      UnsupportedProviderError,
    );
  });

  it('should throw for openai provider when package is not installed', async () => {
    // In this test environment, @ai-sdk/openai is not installed, so dynamic import will fail
    await expect(getModel('openai', 'gpt-4')).rejects.toThrow(
      UnsupportedProviderError,
    );
  });
});

// ===========================================================================
// 4. Error classes
// ===========================================================================
describe('UnsupportedProviderError', () => {
  it('should have correct name and message', () => {
    const error = new UnsupportedProviderError('gemini');
    expect(error.name).toBe('UnsupportedProviderError');
    expect(error.message).toContain('Unsupported LLM provider: "gemini"');
    expect(error.message).toContain('Supported providers');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('LLMInvocationError', () => {
  it('should have correct name, message, and cause', () => {
    const cause = new Error('SDK failure');
    const error = new LLMInvocationError('Text generation failed', cause);
    expect(error.name).toBe('LLMInvocationError');
    expect(error.message).toBe('Text generation failed');
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it('should work without a cause', () => {
    const error = new LLMInvocationError('Something went wrong');
    expect(error.name).toBe('LLMInvocationError');
    expect(error.message).toBe('Something went wrong');
    expect(error.cause).toBeUndefined();
  });
});

// ===========================================================================
// 5. DefaultLLMProvider.invoke()
// ===========================================================================
describe('DefaultLLMProvider', () => {
  describe('invoke()', () => {
    it('should return string response from generateText', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'This is the response.' });

      const provider = new DefaultLLMProvider(makeConfig());
      const result = await provider.invoke('Hello, world!');

      expect(result).toBe('This is the response.');
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('should pass correct parameters to generateText', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'response' });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invoke('test prompt');

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockAnthropicModel,
          prompt: 'test prompt',
          temperature: 0,
          maxTokens: 4096,
          maxRetries: 2,
        }),
      );
    });

    it('should apply per-invocation overrides from InvokeOptions', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'response' });

      const provider = new DefaultLLMProvider(makeConfig());
      const options: InvokeOptions = {
        temperature: 0.8,
        maxTokens: 1024,
        timeout: 5000,
      };
      await provider.invoke('test prompt', options);

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.8,
          maxTokens: 1024,
        }),
      );
    });

    it('should pass callSite to resolveConfig and apply overrides', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'response' });

      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 4096,
          timeout: 30_000,
          maxRetries: 2,
        },
        callSites: {
          'link-classifier': {
            temperature: 0.3,
            maxTokens: 512,
          },
        },
      };

      const provider = new DefaultLLMProvider(config);
      await provider.invoke('classify this link', { callSite: 'link-classifier' });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.3,
          maxTokens: 512,
        }),
      );
    });

    it('should return empty string when LLM returns empty response', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: '' });

      const provider = new DefaultLLMProvider(makeConfig());
      const result = await provider.invoke('prompt');

      expect(result).toBe('');
    });

    it('should throw LLMInvocationError when generateText throws', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('API rate limit exceeded'));

      const provider = new DefaultLLMProvider(makeConfig());

      await expect(provider.invoke('prompt')).rejects.toThrow(LLMInvocationError);
    });

    it('should include original error message in LLMInvocationError', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('API rate limit exceeded'));

      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invoke('prompt');
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain('API rate limit exceeded');
      }
    });

    it('should pass maxRetries to generateText for retry logic', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'response' });

      const config = makeConfig({
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          maxRetries: 5,
        },
      });
      const provider = new DefaultLLMProvider(config);
      await provider.invoke('prompt');

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 5,
        }),
      );
    });

    it('should pass abortSignal to generateText for timeout', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'response' });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invoke('prompt');

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.abortSignal).toBeDefined();
      expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('should not pass abortSignal when timeout is 0 or undefined', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'response' });

      const config = makeConfig({
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          timeout: 0,
        },
      });
      const provider = new DefaultLLMProvider(config);
      await provider.invoke('prompt');

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.abortSignal).toBeUndefined();
    });
  });

  // =========================================================================
  // 6. DefaultLLMProvider.invokeStructured()
  // =========================================================================
  describe('invokeStructured()', () => {
    const testSchema = z.object({
      name: z.string(),
      value: z.number(),
    });

    it('should return parsed object matching Zod schema', async () => {
      const expectedObject = { name: 'test-result', value: 99 };
      mockGenerateObject.mockResolvedValueOnce({ object: expectedObject });

      const provider = new DefaultLLMProvider(makeConfig());
      const result = await provider.invokeStructured('generate data', testSchema);

      expect(result).toEqual(expectedObject);
      expect(result.name).toBe('test-result');
      expect(result.value).toBe(99);
    });

    it('should pass correct parameters to generateObject', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { name: 'test', value: 42 },
      });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invokeStructured('test prompt', testSchema);

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockAnthropicModel,
          prompt: 'test prompt',
          schema: testSchema,
          temperature: 0,
          maxTokens: 4096,
          maxRetries: 2,
        }),
      );
    });

    it('should pass the Zod schema to generateObject', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { name: 'test', value: 42 },
      });

      const customSchema = z.object({
        title: z.string(),
        items: z.array(z.string()),
        count: z.number(),
      });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invokeStructured('prompt', customSchema);

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          schema: customSchema,
        }),
      );
    });

    it('should apply per-invocation overrides from InvokeOptions', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { name: 'test', value: 42 },
      });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invokeStructured('prompt', testSchema, {
        temperature: 0.5,
        maxTokens: 2048,
      });

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          maxTokens: 2048,
        }),
      );
    });

    it('should apply call-site overrides for structured calls', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { name: 'test', value: 42 },
      });

      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          temperature: 0,
          maxTokens: 4096,
          timeout: 30_000,
          maxRetries: 2,
        },
        callSites: {
          'conversion-strategy-selector': {
            temperature: 0.2,
            maxTokens: 1024,
          },
        },
      };

      const provider = new DefaultLLMProvider(config);
      await provider.invokeStructured('prompt', testSchema, {
        callSite: 'conversion-strategy-selector',
      });

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.2,
          maxTokens: 1024,
        }),
      );
    });

    it('should throw LLMInvocationError when generateObject throws', async () => {
      mockGenerateObject.mockRejectedValueOnce(
        new Error('Structured generation failed'),
      );

      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invokeStructured('prompt', testSchema);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain(
          'Structured generation failed',
        );
      }
    });

    it('should throw LLMInvocationError when Zod validation fails in SDK', async () => {
      // The Vercel AI SDK handles Zod validation internally in generateObject.
      // When it fails, the SDK throws an error which we wrap in LLMInvocationError.
      mockGenerateObject.mockRejectedValueOnce(
        new Error('Validation error: Expected string, received number'),
      );

      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invokeStructured('prompt', testSchema);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain('Validation error');
      }
    });

    it('should pass maxRetries to generateObject', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { name: 'test', value: 42 },
      });

      const config = makeConfig({
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          maxRetries: 3,
        },
      });
      const provider = new DefaultLLMProvider(config);
      await provider.invokeStructured('prompt', testSchema);

      expect(mockGenerateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 3,
        }),
      );
    });

    it('should pass abortSignal to generateObject for timeout', async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { name: 'test', value: 42 },
      });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invokeStructured('prompt', testSchema);

      const callArgs = mockGenerateObject.mock.calls[0][0];
      expect(callArgs.abortSignal).toBeDefined();
      expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    });
  });

  // =========================================================================
  // 7. Timeout handling
  // =========================================================================
  describe('timeout handling', () => {
    it('should throw LLMInvocationError with timeout message on AbortError for invoke()', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      mockGenerateText.mockRejectedValueOnce(abortError);

      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invoke('prompt');
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain('timed out');
        expect((e as LLMInvocationError).message).toContain('30000ms');
      }
    });

    it('should throw LLMInvocationError with timeout message on AbortError for invokeStructured()', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      mockGenerateObject.mockRejectedValueOnce(abortError);

      const schema = z.object({ name: z.string() });
      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invokeStructured('prompt', schema);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain('timed out');
        expect((e as LLMInvocationError).message).toContain('30000ms');
      }
    });

    it('should detect AbortError by error name property', async () => {
      // Some environments throw a plain Error with name set to 'AbortError'
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockGenerateText.mockRejectedValueOnce(abortError);

      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invoke('prompt');
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain('timed out');
      }
    });

    it('should use custom timeout from invoke options', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      mockGenerateText.mockRejectedValueOnce(abortError);

      const provider = new DefaultLLMProvider(makeConfig());

      try {
        await provider.invoke('prompt', { timeout: 5000 });
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMInvocationError);
        expect((e as LLMInvocationError).message).toContain('5000ms');
      }
    });
  });

  // =========================================================================
  // 8. Retry logic (via maxRetries passed to SDK)
  // =========================================================================
  describe('retry logic', () => {
    it('should pass maxRetries from defaults to generateText', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'ok' });

      const provider = new DefaultLLMProvider(makeConfig());
      await provider.invoke('prompt');

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 2,
        }),
      );
    });

    it('should pass maxRetries from call-site override to generateText', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'ok' });

      const config: LLMConfig = {
        defaults: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          maxRetries: 2,
        },
        callSites: {
          'agent-router': {
            maxRetries: 5,
          },
        },
      };

      const provider = new DefaultLLMProvider(config);
      await provider.invoke('prompt', { callSite: 'agent-router' });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 5,
        }),
      );
    });

    it('should still throw LLMInvocationError after retries are exhausted', async () => {
      mockGenerateText.mockRejectedValueOnce(
        new Error('Service unavailable after retries'),
      );

      const provider = new DefaultLLMProvider(makeConfig());

      await expect(provider.invoke('prompt')).rejects.toThrow(LLMInvocationError);
    });
  });
});

// ===========================================================================
// 9. createLLMProvider factory
// ===========================================================================
describe('createLLMProvider', () => {
  it('should return an LLMProvider instance', () => {
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.invoke).toBe('function');
    expect(typeof provider.invokeStructured).toBe('function');
  });

  it('should use DEFAULT_LLM_CONFIG when no config is provided', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'response' });

    const provider = createLLMProvider();
    await provider.invoke('test');

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        maxTokens: 4096,
        maxRetries: 2,
      }),
    );
  });

  it('should use provided config when given', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'response' });

    const customConfig: LLMConfig = {
      defaults: {
        provider: 'anthropic',
        model: 'custom-model',
        temperature: 0.9,
        maxTokens: 1000,
        maxRetries: 0,
      },
    };

    const provider = createLLMProvider(customConfig);
    await provider.invoke('test');

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.9,
        maxTokens: 1000,
        maxRetries: 0,
      }),
    );
  });

  it('should return a DefaultLLMProvider instance', () => {
    const provider = createLLMProvider();
    expect(provider).toBeInstanceOf(DefaultLLMProvider);
  });
});

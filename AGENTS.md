# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**website-fetch** is a TypeScript CLI tool and SDK for crawling websites and converting content to structured markdown. It targets two use cases: product research (aggregate a product website's content) and documentation gathering (fetch docs into local markdown). Input is always a root URL + description — it is not a general search tool.

## Commands

```bash
npm run build          # Compile TypeScript (tsc) → dist/
npm run test           # Run all tests (vitest run)
npm run lint           # ESLint on src/
npm run type-check     # TypeScript type checking without emit (tsc --noEmit)

# Run a single test file
npx vitest run src/__tests__/crawler-simple.test.ts

# Run tests matching a pattern
npx vitest run -t "should respect maxPages"

# CLI usage (after build)
node dist/bin/website-fetch.js https://example.com --mode smart -d "API docs"

# CLI usage (dev, without build)
npx tsx src/bin/website-fetch.ts https://example.com -o ./test-output
```

## Architecture

### Three Crawling Modes

All modes share the same fetcher, converter, and output layers. They differ only in **link selection strategy**:

- **Simple** (`src/crawler/simple.ts`): BFS crawl, rule-based filtering (domain, glob patterns, depth, page limit). No LLM.
- **Smart** (`src/crawler/smart.ts`): BFS with LLM link classification. Supports batch (one LLM call per page, default) and per-link classification modes.
- **Agent** (`src/crawler/agent.ts`): LLM conversation loop with tool access (`fetchPage`, `storePage`, `markIrrelevant`, `getLinks`, `done`). Agent sees page summaries, not full content. Uses Vercel AI SDK `generateText` with tool calling.

### Three-Layer Conversion Pipeline (`src/converter/`)

| Layer | What | When active |
|-------|------|-------------|
| Layer 1 | Base HTML→markdown (strategy: `default`/`readability`/`custom`) | Always |
| Layer 2 | LLM picks best strategy per page (`strategy-selector.ts`) | Smart + Agent modes |
| Layer 3 | LLM optimization loop — checks completeness/noise/structure (`optimizer.ts`) | Agent mode (default) |

Mode defaults: Simple uses `default` strategy. Smart/Agent use `readability`. Only Agent enables the optimizer loop by default. All are overridable via config.

### LLM Abstraction (`src/llm/`)

All LLM calls go through `LLMProvider` interface — no module imports from `ai` (Vercel AI SDK) directly except in `src/llm/provider.ts`. Each LLM call has a named **call site key** (e.g., `link-classifier`, `agent-router`, `page-summarizer`, `conversion-optimizer`). The `LLMConfig` supports global defaults plus per-call-site overrides for model, temperature, maxTokens, timeout, maxRetries.

Default model: `claude-haiku-4-5-20251001` via Anthropic provider. OpenAI supported via dynamic import.

### Fetcher (`src/fetcher/`)

HTTP layer with: robots.txt respect (cached per origin), adaptive rate limiting (backs off on 429/5xx, recovers on sustained success), concurrency via `p-queue`, cookie file support (Netscape format), redirect handling (max 5), 30s timeout default. The `FetchQueue` wraps `AdaptiveRateLimiter` and `p-queue`.

### Output (`src/output/`)

Three structures: **mirror** (preserves URL path hierarchy), **flat** (all files in one dir), **single-file** (aggregated). YAML front matter with source URL and fetchedAt. Optional INDEX.md generation with LLM-powered page descriptions.

### SDK Entry Point (`src/sdk/index.ts`)

`websiteFetch(config)` is the main API. Validates config, creates components via factory functions, selects crawler, runs crawl, optionally generates index and single file. Re-exports all building blocks for advanced usage.

### Configuration (`src/types.ts`)

Single `WebsiteFetchConfig` interface (34 fields). `CONFIG_DEFAULTS` provides sensible defaults. Mode-specific conversion defaults are applied in `src/sdk/index.ts` via `MODE_CONVERSION_DEFAULTS`. Smart/Agent modes require `description`.

## Key Patterns

### Factory Functions
Every major component uses a factory: `createFetcher(config)`, `createConverter(config)`, `createLLMProvider(llmConfig)`, `createOutputWriter(config)`. These return interface-typed objects. Follow this pattern when adding new components.

### Module Exports
Each directory has an `index.ts` barrel file. The package exports subpath entries (`.`, `./fetcher`, `./converter`, `./llm`, `./crawler`, `./output`) mapped in `package.json` "exports".

### ESM with Node16 Resolution
The project uses `"type": "module"` and `"module": "Node16"` in tsconfig. All internal imports **must use `.js` extensions** (e.g., `import { Foo } from './bar.js'`), even though the source files are `.ts`. This is required by Node16 module resolution.

### Error Resilience
Crawlers continue on per-page errors. LLM layers fall back to defaults on failure. The `FetchError` class carries url, statusCode, and headers for rate limiter integration.

### Streaming Output
Pages are written to disk immediately after fetch+convert (not accumulated in memory first). The crawl result `FetchResult` aggregates stats and page metadata.

## Testing Patterns

Tests are in `src/__tests__/` using Vitest. The test approach is mock-heavy:

- **Helper functions**: Each test file defines `makeConfig()` (minimal valid config), `makeFetchedPageRaw()`, `makeHtml()` (page with links), `createMockFetcher()`, `createMockConverter()`, `createMockOutputWriter()`.
- **Mocking**: Uses `vi.mock()` for module-level mocks and `vi.fn()` for function mocks. Mock declarations go **before** imports of the mocked module.
- **Temp directories**: File-writing tests use `mkdtemp(join(tmpdir(), 'prefix-'))` in `beforeEach` and `rm(tempDir, { recursive: true })` in `afterEach`.
- **Test naming**: Tests for `src/foo/bar.ts` go in `src/__tests__/bar.test.ts` (not mirrored directory structure).

## Non-Goals (by design)

- No browser rendering / JS execution (no Puppeteer/Playwright)
- No incremental / resumable crawls
- No authentication flows (OAuth, login forms) — only static headers/cookies
- No UI or web interface

## Design Documents

- Architecture: `vbcd-dev/dev-plans/initial-version/2026-02-06-website-fetch-design.md`
- Feature breakdown: `vbcd-dev/dev-plans/initial-version/2026-02-07-website-fetch-feature-breakdown.md`
- Implementation spec: `vbcd-dev/features-impl/website-fetch-initial/spec.md`

# website-fetch

A TypeScript CLI and SDK for crawling websites and converting their content to structured markdown. Given a root URL and a description of what to fetch, it crawls pages under that domain and produces clean markdown output — ready for product research, documentation aggregation, or content analysis.

## Features

- **Three crawling modes** — simple (BFS, no LLM), smart (BFS with LLM link classification), and agent (autonomous LLM conversation loop with tools)
- **HTML-to-markdown conversion** with multiple strategies (Turndown, Mozilla Readability, custom) and an optional LLM optimization loop
- **Adaptive rate limiting** — automatically backs off on 429/5xx responses, recovers on sustained success, respects `robots.txt` crawl-delay
- **Flexible output** — mirror (preserves URL directory structure), flat (single directory), or single aggregated file, with YAML front matter and optional INDEX.md generation
- **LLM provider abstraction** — default Anthropic Claude via Vercel AI SDK, with OpenAI support and per-call-site model/parameter overrides
- **URL scope control** — glob-based include/exclude patterns, max depth, max pages
- **Authentication support** — custom HTTP headers and Netscape-format cookie files
- **Usable as a CLI or as a programmatic SDK** with full TypeScript types

## Installation

```bash
npm install website-fetch
```

Requires Node.js >= 18.

For smart and agent modes, set your LLM provider API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or for OpenAI:
export OPENAI_API_KEY=sk-...
```

## Usage — CLI

```bash
website-fetch <url> [options]
```

### Quick Start

```bash
# Simple mode — crawl everything under the domain, no LLM needed
website-fetch https://docs.example.com -o ./output

# Smart mode — LLM filters which links to follow
website-fetch https://docs.example.com --mode smart -d "API reference docs only" -o ./output

# Agent mode — LLM autonomously decides what to fetch, store, or skip
website-fetch https://example.com --mode agent -d "Product pricing and feature pages" -o ./output
```

### What the Output Looks Like

After running:

```bash
website-fetch https://docs.example.com --mode smart -d "API reference" -o ./api-docs
```

You get a directory structure like this (mirror mode, the default):

```
api-docs/
├── INDEX.md
├── index.md                    # docs.example.com root
├── api/
│   ├── authentication.md
│   ├── endpoints.md
│   └── errors.md
└── guides/
    └── getting-started.md
```

Each markdown file includes YAML front matter:

```markdown
---
source: https://docs.example.com/api/authentication
fetchedAt: 2026-02-09T14:30:00.000Z
---

# Authentication

To authenticate API requests, include your API key in the Authorization header...
```

The `INDEX.md` is a table of contents with links to all fetched pages:

```markdown
# Site Index: docs.example.com

- [Docs Home](index.md) — Main documentation landing page
  - [Authentication](api/authentication.md) — How to set up API keys and OAuth flows
  - [Endpoints](api/endpoints.md) — Full reference of available API endpoints
  - [Errors](api/errors.md) — Error codes and troubleshooting
  - [Getting Started](guides/getting-started.md) — Step-by-step setup for new users

Total: 5 pages fetched
```

### All CLI Options

```
Positional:
  url                              Root URL to crawl

Mode:
  -m, --mode <mode>                simple | smart | agent (default: simple)
  -d, --description <text>         What to fetch (required for smart/agent)

Scope:
  --depth <n>                      Max crawl depth (default: 5)
  --max-pages <n>                  Max pages to fetch (default: 100)
  --include <pattern>              URL patterns to include (repeatable)
  --exclude <pattern>              URL patterns to exclude (repeatable)
  --prefix <path>                  Only follow links under this URL path prefix

Output:
  -o, --output <dir>               Output directory (default: ./output)
  --flat                           Flat file structure instead of mirror
  --single-file                    Also generate single aggregated file
  --no-index                       Skip index file generation

Conversion:
  --conversion <strategy>          default | readability
  --optimize-conversion            Enable LLM conversion optimization loop
  --no-optimize-conversion         Disable it (override mode default)

Fetching:
  --delay <ms>                     Delay between requests (default: 200)
  --concurrency <n>                Parallel requests (default: 3)
  --ignore-robots                  Ignore robots.txt
  --header <key:value>             Custom header (repeatable)
  --cookie-file <path>             Path to cookie file (Netscape format)

LLM:
  --llm-config <path>              Path to LLM config JSON file
  --model <model>                  Override default model
  --provider <provider>            Override default provider (anthropic | openai)

Smart mode:
  --link-classification <strategy> batch | per-link (default: batch)

General:
  -v, --verbose                    Verbose logging
  -q, --quiet                      Suppress output except errors
  --dry-run                        Show what would be fetched without fetching
  -V, --version                    Output version number
  -h, --help                       Display help
```

## Usage — SDK

The SDK exposes `websiteFetch()` as the main entry point. Only `url` is required — everything else has sensible defaults.

```typescript
import { websiteFetch } from 'website-fetch';

const result = await websiteFetch({
  url: 'https://docs.example.com',
});

console.log(`Fetched ${result.stats.totalPages} pages in ${result.stats.duration}ms`);
console.log(`Output: ${result.outputPath}`);
console.log(`Index: ${result.indexPath}`);
```

### Smart mode with LLM filtering

```typescript
const result = await websiteFetch({
  url: 'https://docs.example.com',
  mode: 'smart',
  description: 'API reference documentation',
  maxPages: 50,
});
```

### Agent mode with full LLM control

```typescript
const result = await websiteFetch({
  url: 'https://example.com',
  mode: 'agent',
  description: 'Product pricing pages and feature comparisons',
  outputDir: './product-research',
  singleFile: true,
});
```

### Result Object

`websiteFetch()` returns a `FetchResult`:

```typescript
interface FetchResult {
  pages: FetchedPage[];       // All successfully fetched pages
  skipped: SkippedPage[];     // Pages that were skipped (with reasons)
  outputPath: string;         // Output directory path
  indexPath?: string;         // Path to INDEX.md (if generated)
  singleFilePath?: string;    // Path to aggregated.md (if requested)
  stats: {
    totalPages: number;
    totalSkipped: number;
    duration: number;         // Milliseconds
  };
}
```

### Progress Callbacks

```typescript
const result = await websiteFetch({
  url: 'https://example.com',
  onPageFetched: (page) => console.log(`Fetched: ${page.url}`),
  onPageSkipped: (url, reason) => console.log(`Skipped: ${url} (${reason})`),
  onError: (url, error) => console.error(`Error: ${url} — ${error.message}`),
});
```

### Using Individual Building Blocks

For advanced use cases, you can import and compose the components directly:

```typescript
import {
  createFetcher,
  createConverter,
  createLLMProvider,
  createOutputWriter,
  SimpleCrawler,
  SmartCrawler,
  AgentCrawler,
} from 'website-fetch';

// Or import from subpaths:
import { createFetcher } from 'website-fetch/fetcher';
import { createConverter } from 'website-fetch/converter';
import { createLLMProvider } from 'website-fetch/llm';
import { createOutputWriter } from 'website-fetch/output';
import { SimpleCrawler, SmartCrawler, AgentCrawler } from 'website-fetch/crawler';
```

## Configuration Reference

All fields below are optional except `url`. When using smart or agent mode, `description` is also required.

### Mode

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | **(required)** | Root URL to crawl |
| `mode` | `'simple' \| 'smart' \| 'agent'` | `'simple'` | Crawling mode |
| `description` | `string` | — | What content to crawl. Required for smart/agent modes |

### Scope

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxDepth` | `number` | `5` | Maximum link depth from the root URL |
| `maxPages` | `number` | `100` | Maximum number of pages to fetch |
| `includePatterns` | `string[]` | — | Glob patterns for URL paths to include |
| `excludePatterns` | `string[]` | — | Glob patterns for URL paths to exclude |
| `pathPrefix` | `string` | — | Only follow links whose pathname starts with this prefix |

Glob patterns match against the URL pathname. Supported syntax: `*` (any chars except `/`), `**` (any chars including `/`), `?` (single char).

### Output

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `outputDir` | `string` | `'./output'` | Directory to write output files |
| `outputStructure` | `'mirror' \| 'flat'` | `'mirror'` | File structure strategy |
| `singleFile` | `boolean` | `false` | Also generate a single aggregated markdown file |
| `generateIndex` | `boolean` | `true` | Generate an INDEX.md table of contents |

### Conversion

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `conversionStrategy` | `'default' \| 'readability' \| 'custom'` | per mode* | HTML-to-markdown conversion strategy |
| `optimizeConversion` | `boolean` | per mode* | Enable the LLM conversion optimization loop |
| `customConverter` | `(html: string, url: string) => Promise<string>` | — | Custom converter function (when strategy is `'custom'`) |

*Mode defaults:

| Mode | `conversionStrategy` | `optimizeConversion` |
|------|---------------------|---------------------|
| simple | `'default'` | `false` |
| smart | `'readability'` | `false` |
| agent | `'readability'` | `true` |

### Fetching

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `delay` | `number` | `200` | Base delay between requests in milliseconds |
| `concurrency` | `number` | `3` | Maximum parallel requests |
| `respectRobots` | `boolean` | `true` | Honor robots.txt rules and crawl-delay |
| `adaptiveRateLimit` | `boolean` | `true` | Dynamically adjust delay based on server responses |
| `headers` | `Record<string, string>` | — | Custom HTTP headers applied to every request |
| `cookieFile` | `string` | — | Path to a Netscape-format cookie file |

### LLM

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `llmProvider` | `LLMProvider` | — | Custom LLM provider implementation |
| `llmConfig` | `LLMConfig` | Anthropic Haiku | LLM configuration with defaults and per-call-site overrides |
| `model` | `string` | `'claude-haiku-4-5-20251001'` | Shorthand to override the default model |

### Smart Mode

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `linkClassification` | `'batch' \| 'per-link'` | `'batch'` | How the LLM classifies links |

### Events

| Field | Type | Description |
|-------|------|-------------|
| `onPageFetched` | `(page: FetchedPage) => void` | Called after each page is fetched and converted |
| `onPageSkipped` | `(url: string, reason: string) => void` | Called when a page is skipped |
| `onError` | `(url: string, error: Error) => void` | Called on per-page errors |

## Use Cases and Configuration Examples

### Crawl an entire documentation site

No LLM needed. BFS crawl with default settings:

```bash
website-fetch https://docs.example.com -o ./docs
```

```typescript
await websiteFetch({
  url: 'https://docs.example.com',
  outputDir: './docs',
});
```

### Fetch only API reference pages

Use smart mode to let the LLM decide which links lead to API reference content, and include/exclude patterns to narrow the scope:

```bash
website-fetch https://docs.example.com \
  --mode smart \
  -d "API reference documentation" \
  --include "/api/**" --include "/reference/**" \
  --exclude "/blog/**" \
  --max-pages 200 \
  -o ./api-docs
```

```typescript
await websiteFetch({
  url: 'https://docs.example.com',
  mode: 'smart',
  description: 'API reference documentation',
  includePatterns: ['/api/**', '/reference/**'],
  excludePatterns: ['/blog/**'],
  maxPages: 200,
  outputDir: './api-docs',
});
```

### Restrict crawl to a URL path prefix

Use `--prefix` to limit the crawl to pages under a specific path. This is simpler than include patterns when you just want to scope to a subtree of the site:

```bash
website-fetch https://docs.example.com \
  --prefix /api/v2 \
  --max-pages 50 \
  -o ./api-v2-docs
```

```typescript
await websiteFetch({
  url: 'https://docs.example.com',
  pathPrefix: '/api/v2',
  maxPages: 50,
  outputDir: './api-v2-docs',
});
```

Note: the root URL is always fetched regardless of the prefix. The prefix only constrains which *discovered links* are followed. A prefix of `/api/v2` matches `/api/v2`, `/api/v2/`, and `/api/v2/users`, but not `/api/v2other`.

### Aggregate product research into a single file

Use agent mode and single-file output to get one combined document:

```bash
website-fetch https://example.com \
  --mode agent \
  -d "Product features, pricing, and comparison pages" \
  --single-file \
  --max-pages 30 \
  -o ./research
```

```typescript
await websiteFetch({
  url: 'https://example.com',
  mode: 'agent',
  description: 'Product features, pricing, and comparison pages',
  singleFile: true,
  maxPages: 30,
  outputDir: './research',
});
```

This produces `./research/aggregated.md` with all pages concatenated:

```markdown
# Aggregated Content: example.com

---
## Source: https://example.com/pricing

[pricing page content...]

---
## Source: https://example.com/features

[features page content...]
```

### Crawl pages behind authentication

Pass custom headers or a cookie file to access authenticated content:

```bash
website-fetch https://internal.example.com \
  --header "Authorization:Bearer tok_abc123" \
  --header "X-Custom:value" \
  --ignore-robots \
  -o ./internal-docs
```

```typescript
await websiteFetch({
  url: 'https://internal.example.com',
  headers: {
    'Authorization': 'Bearer tok_abc123',
    'X-Custom': 'value',
  },
  respectRobots: false,
  outputDir: './internal-docs',
});
```

With a cookie file (Netscape/curl format):

```bash
website-fetch https://internal.example.com \
  --cookie-file ./cookies.txt \
  -o ./internal-docs
```

### Control crawl speed for rate-limited sites

Increase delay and reduce concurrency for sites that throttle aggressively:

```bash
website-fetch https://fragile-api.example.com \
  --delay 1000 \
  --concurrency 1 \
  -o ./output
```

```typescript
await websiteFetch({
  url: 'https://fragile-api.example.com',
  delay: 1000,
  concurrency: 1,
  outputDir: './output',
});
```

The adaptive rate limiter will still back off further if it encounters 429 responses, and gradually recover after sustained success.

To disable adaptive behavior entirely and use a fixed delay:

```typescript
await websiteFetch({
  url: 'https://example.com',
  delay: 500,
  adaptiveRateLimit: false,
});
```

### Use a flat output structure

Put all files in a single directory instead of mirroring the URL hierarchy:

```bash
website-fetch https://docs.example.com --flat -o ./flat-docs
```

Produces:

```
flat-docs/
├── INDEX.md
├── index.md
├── api_authentication.md
├── api_endpoints.md
└── guides_getting-started.md
```

### Use the readability conversion strategy

For content-heavy pages with lots of navigation and sidebar noise, the readability strategy (powered by Mozilla Readability) extracts only the main article content before converting to markdown:

```bash
website-fetch https://blog.example.com --conversion readability -o ./clean-blog
```

```typescript
await websiteFetch({
  url: 'https://blog.example.com',
  conversionStrategy: 'readability',
  outputDir: './clean-blog',
});
```

### Use a custom converter

Provide your own HTML-to-markdown function:

```typescript
await websiteFetch({
  url: 'https://example.com',
  conversionStrategy: 'custom',
  customConverter: async (html, url) => {
    // Your custom conversion logic
    return myCustomParser(html);
  },
});
```

### Enable the LLM conversion optimization loop

The optimizer compares the original HTML against the markdown output and checks for completeness, noise, and structural integrity. It runs up to 2 refinement iterations. It is on by default in agent mode, but you can enable it in any mode:

```bash
website-fetch https://example.com --optimize-conversion -o ./optimized
```

```typescript
await websiteFetch({
  url: 'https://example.com',
  optimizeConversion: true,
});
```

Or disable it in agent mode:

```bash
website-fetch https://example.com --mode agent -d "All docs" --no-optimize-conversion
```

### Configure the LLM per call site

Every place the system calls an LLM is a named "call site" that can be configured independently. Create an LLM config JSON file:

```json
{
  "defaults": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5-20250929",
    "temperature": 0,
    "maxTokens": 4096,
    "timeout": 30000,
    "maxRetries": 2
  },
  "callSites": {
    "agent-router": {
      "model": "claude-sonnet-4-5-20250929",
      "maxTokens": 8192
    },
    "page-summarizer": {
      "model": "claude-haiku-4-5-20251001",
      "maxTokens": 1024
    },
    "link-classifier": {
      "model": "claude-haiku-4-5-20251001",
      "maxTokens": 2048
    },
    "link-classifier-per-link": {
      "model": "claude-haiku-4-5-20251001",
      "maxTokens": 256
    },
    "conversion-strategy-selector": {
      "model": "claude-haiku-4-5-20251001"
    },
    "conversion-optimizer": {
      "model": "claude-sonnet-4-5-20250929"
    },
    "index-generator": {
      "model": "claude-haiku-4-5-20251001",
      "maxTokens": 512
    }
  }
}
```

```bash
website-fetch https://example.com --mode agent -d "All docs" --llm-config ./llm-config.json
```

```typescript
await websiteFetch({
  url: 'https://example.com',
  mode: 'agent',
  description: 'All documentation',
  llmConfig: {
    defaults: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      temperature: 0,
      maxTokens: 4096,
    },
    callSites: {
      'page-summarizer': { model: 'claude-haiku-4-5-20251001', maxTokens: 1024 },
      'agent-router': { maxTokens: 8192 },
    },
  },
});
```

Available call site keys:

| Call Site | Used In | Purpose |
|-----------|---------|---------|
| `link-classifier` | Smart mode | Batch-classify all links on a page |
| `link-classifier-per-link` | Smart mode | Classify a single link (per-link strategy) |
| `agent-router` | Agent mode | Central agent conversation loop |
| `page-summarizer` | Agent mode | Summarize fetched pages for agent context |
| `conversion-strategy-selector` | Smart/Agent | Pick the best conversion strategy per page |
| `conversion-optimizer` | All modes (when enabled) | Compare HTML vs markdown, refine conversion |
| `index-generator` | All modes | Generate one-sentence page descriptions for INDEX.md |

### Use OpenAI instead of Anthropic

```bash
export OPENAI_API_KEY=sk-...
website-fetch https://example.com --mode smart -d "API docs" --provider openai --model gpt-4o
```

```typescript
await websiteFetch({
  url: 'https://example.com',
  mode: 'smart',
  description: 'API docs',
  llmConfig: {
    defaults: {
      provider: 'openai',
      model: 'gpt-4o',
    },
  },
});
```

Note: OpenAI support requires installing `@ai-sdk/openai` separately:

```bash
npm install @ai-sdk/openai
```

### Provide a custom LLM provider

Implement the `LLMProvider` interface to integrate any LLM service:

```typescript
import { websiteFetch } from 'website-fetch';
import type { LLMProvider } from 'website-fetch';

const myProvider: LLMProvider = {
  async invoke(prompt, options) {
    // Your LLM call returning plain text
    return await myLLMService.complete(prompt);
  },
  async invokeStructured(prompt, schema, options) {
    // Your LLM call returning a Zod-validated object
    const raw = await myLLMService.complete(prompt);
    return schema.parse(JSON.parse(raw));
  },
};

await websiteFetch({
  url: 'https://example.com',
  mode: 'smart',
  description: 'API docs',
  llmProvider: myProvider,
});
```

### Smart mode link classification strategies

Batch mode (default) sends all discovered links in a single LLM call — faster and cheaper. Per-link mode calls the LLM separately for each link — more precise but more calls:

```bash
# Per-link classification (more precise, more LLM calls)
website-fetch https://example.com --mode smart -d "API docs" --link-classification per-link
```

```typescript
await websiteFetch({
  url: 'https://example.com',
  mode: 'smart',
  description: 'API docs',
  linkClassification: 'per-link',
});
```

### Preview a crawl without fetching

Dry-run mode shows the resolved configuration without making any HTTP requests:

```bash
website-fetch https://example.com --mode smart -d "API docs" --dry-run
```

## How the Crawling Modes Work

### Simple Mode

Breadth-first traversal with rule-based link filtering. No LLM required.

```
fetch root → extract links → filter (same domain + patterns + depth) → queue → repeat
```

Every page is fetched and converted. Links are followed if they pass: same-domain check, include/exclude patterns, max depth, and max pages limit.

### Smart Mode

Same BFS structure as simple mode, but after each page is fetched, the LLM classifies which discovered links are relevant to the `description`.

In **batch mode** (default), all links from a page are presented in a numbered list with their surrounding paragraph context. The LLM returns which numbers are relevant — one call per page.

In **per-link mode**, each link gets its own LLM call with a yes/no decision. More calls, but each can use a cheaper/faster model.

### Agent Mode

A single LLM conversation loop that autonomously decides what to fetch, store, or skip. The agent has five tools:

| Tool | What it does |
|------|-------------|
| `fetchPage(url)` | Fetches a page, converts to markdown, returns a summary (not full content) |
| `storePage(url)` | Persists a fetched page to the output, returns discovered links |
| `markIrrelevant(url)` | Discards a fetched page, returns discovered links |
| `getLinks(url)` | Returns links from a fetched page without storing or discarding |
| `done()` | Signals the crawl is complete |

The agent never sees full page content in its conversation — only summaries. This keeps the context window manageable across large crawls. Fetched pages are held in temporary in-memory storage until the agent decides to store or discard them.

## License

ISC

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { IndexGenerator, extractTitle } from '../output/index-generator.js';
import type { IndexEntry } from '../output/index-generator.js';
import type { FetchedPage } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal FetchedPage for testing */
function makePage(overrides: Partial<FetchedPage> & { url: string }): FetchedPage {
  return {
    html: '<html></html>',
    statusCode: 200,
    headers: {},
    fetchedAt: new Date(),
    markdown: '',
    depth: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe('extractTitle', () => {
  it('should extract the title from a markdown H1 heading', () => {
    const markdown = '# My Page Title\n\nSome content here.';
    const result = extractTitle(markdown, 'https://example.com/page');
    expect(result).toBe('My Page Title');
  });

  it('should extract the first H1 heading when multiple exist', () => {
    const markdown = '# First Title\n\n## Second\n\n# Another Title';
    const result = extractTitle(markdown, 'https://example.com/page');
    expect(result).toBe('First Title');
  });

  it('should trim whitespace from extracted headings', () => {
    const markdown = '#   Spaced Title   \n\nContent';
    const result = extractTitle(markdown, 'https://example.com/page');
    expect(result).toBe('Spaced Title');
  });

  it('should not match H2 or lower headings as a title', () => {
    const markdown = '## Subtitle Only\n\nNo H1 here.';
    const result = extractTitle(markdown, 'https://example.com/page');
    // Should fall back to URL-derived title since no H1
    expect(result).not.toBe('Subtitle Only');
  });

  it('should fallback to URL-derived title when no heading is present', () => {
    const markdown = 'Just some plain text without any heading.';
    const result = extractTitle(markdown, 'https://example.com/docs/api-guide');
    expect(result).toBe('Api Guide');
  });

  it('should derive title from URL replacing hyphens with spaces', () => {
    const markdown = 'No heading here.';
    const result = extractTitle(markdown, 'https://example.com/my-awesome-page');
    expect(result).toBe('My Awesome Page');
  });

  it('should derive title from URL replacing underscores with spaces', () => {
    const markdown = '';
    const result = extractTitle(markdown, 'https://example.com/my_page_title');
    expect(result).toBe('My Page Title');
  });

  it('should use hostname as title for root URL when no heading', () => {
    const markdown = 'No heading.';
    const result = extractTitle(markdown, 'https://example.com/');
    expect(result).toBe('example.com');
  });

  it('should handle empty markdown string with URL fallback', () => {
    const result = extractTitle('', 'https://example.com/getting-started');
    expect(result).toBe('Getting Started');
  });

  it('should extract heading even with content before it', () => {
    const markdown = 'Some preamble\n\n# The Real Title\n\nContent after';
    const result = extractTitle(markdown, 'https://example.com/page');
    expect(result).toBe('The Real Title');
  });
});

// ---------------------------------------------------------------------------
// IndexGenerator
// ---------------------------------------------------------------------------

describe('IndexGenerator', () => {
  let generator: IndexGenerator;
  let tmpDir: string;

  beforeEach(async () => {
    generator = new IndexGenerator();
    tmpDir = await mkdtemp(join(tmpdir(), 'index-gen-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Header and Footer format
  // -------------------------------------------------------------------------

  describe('header and footer', () => {
    it('should write header with domain from pages', async () => {
      const pages = [
        makePage({
          url: 'https://docs.example.com/guide',
          markdown: '# Guide',
          depth: 0,
        }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('# Site Index: docs.example.com');
    });

    it('should write footer with total page count', async () => {
      const pages = [
        makePage({ url: 'https://example.com/a', markdown: '# A', depth: 0 }),
        makePage({ url: 'https://example.com/b', markdown: '# B', depth: 0 }),
        makePage({ url: 'https://example.com/c', markdown: '# C', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('Total: 3 pages fetched');
    });

    it('should format header as "# Site Index: {domain}"', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const firstLine = content.split('\n')[0];

      expect(firstLine).toBe('# Site Index: example.com');
    });
  });

  // -------------------------------------------------------------------------
  // Output file location
  // -------------------------------------------------------------------------

  describe('output file', () => {
    it('should write INDEX.md to the output directory', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      const result = await generator.generate(pages, tmpDir, 'flat');

      expect(result).toBe(join(tmpDir, 'INDEX.md'));

      // Verify file actually exists by reading it
      const content = await readFile(result, 'utf-8');
      expect(content).toBeTruthy();
    });

    it('should create the output directory if it does not exist', async () => {
      const nestedDir = join(tmpDir, 'nested', 'deep', 'dir');
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      const result = await generator.generate(pages, nestedDir, 'flat');
      const content = await readFile(result, 'utf-8');
      expect(content).toContain('# Site Index:');
    });
  });

  // -------------------------------------------------------------------------
  // Mirror mode
  // -------------------------------------------------------------------------

  describe('mirror mode', () => {
    it('should generate index with correct hierarchy and indentation', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
        makePage({ url: 'https://example.com/docs', markdown: '# Docs', depth: 1 }),
        makePage({ url: 'https://example.com/docs/api', markdown: '# API', depth: 2 }),
        makePage({ url: 'https://example.com/docs/api/auth', markdown: '# Auth', depth: 3 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const lines = content.split('\n');

      // Find the entry lines (start with optional spaces and "- [")
      const entryLines = lines.filter((l) => l.trimStart().startsWith('- ['));

      expect(entryLines).toHaveLength(4);

      // Depth 0: no indentation
      expect(entryLines[0]).toMatch(/^- \[Home\]/);
      // Depth 1: 2 spaces
      expect(entryLines[1]).toMatch(/^  - \[Docs\]/);
      // Depth 2: 4 spaces
      expect(entryLines[2]).toMatch(/^    - \[API\]/);
      // Depth 3: 6 spaces
      expect(entryLines[3]).toMatch(/^      - \[Auth\]/);
    });

    it('should use 2 spaces per depth level for indentation', async () => {
      const pages = [
        makePage({ url: 'https://example.com/level0', markdown: '# L0', depth: 0 }),
        makePage({ url: 'https://example.com/level0/level1', markdown: '# L1', depth: 1 }),
        makePage({ url: 'https://example.com/level0/level1/level2', markdown: '# L2', depth: 2 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const entryLines = content.split('\n').filter((l) => l.trimStart().startsWith('- ['));

      // Check exact indentation
      expect(entryLines[0]).toMatch(/^- /);
      expect(entryLines[1]).toMatch(/^  - /);
      expect(entryLines[2]).toMatch(/^    - /);
    });

    it('should include relative path links in mirror mode', async () => {
      const pages = [
        makePage({ url: 'https://example.com/docs/guide', markdown: '# Guide', depth: 1 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Mirror mode: docs/guide.md relative to INDEX.md location (same dir)
      expect(content).toContain('[Guide](docs/guide.md)');
    });

    it('should sort entries by depth then by URL path', async () => {
      const pages = [
        makePage({ url: 'https://example.com/z-page', markdown: '# Z', depth: 0 }),
        makePage({ url: 'https://example.com/a-page', markdown: '# A', depth: 0 }),
        makePage({ url: 'https://example.com/a-page/child', markdown: '# Child', depth: 1 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const entryLines = content.split('\n').filter((l) => l.trimStart().startsWith('- ['));

      // Depth 0 entries sorted alphabetically: a-page before z-page
      expect(entryLines[0]).toContain('[A]');
      expect(entryLines[1]).toContain('[Z]');
      // Depth 1 entry comes after depth 0
      expect(entryLines[2]).toContain('[Child]');
    });
  });

  // -------------------------------------------------------------------------
  // Flat mode
  // -------------------------------------------------------------------------

  describe('flat mode', () => {
    it('should generate index with correct flat list (no indentation)', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
        makePage({ url: 'https://example.com/about', markdown: '# About', depth: 1 }),
        makePage({ url: 'https://example.com/docs/api', markdown: '# API', depth: 2 }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const entryLines = content.split('\n').filter((l) => l.startsWith('- ['));

      // All entries should be at the same level (no indentation)
      expect(entryLines.length).toBeGreaterThanOrEqual(3);
      for (const line of entryLines) {
        expect(line).toMatch(/^- \[/);
      }
    });

    it('should sort flat entries by relative path', async () => {
      const pages = [
        makePage({ url: 'https://example.com/z-page', markdown: '# Z', depth: 0 }),
        makePage({ url: 'https://example.com/a-page', markdown: '# A', depth: 0 }),
        makePage({ url: 'https://example.com/m-page', markdown: '# M', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const entryLines = content.split('\n').filter((l) => l.startsWith('- ['));

      // Flat mode entries should be sorted by relativePath (file name)
      // a-page.md < m-page.md < z-page.md
      expect(entryLines[0]).toContain('[A]');
      expect(entryLines[1]).toContain('[M]');
      expect(entryLines[2]).toContain('[Z]');
    });

    it('should include relative path links in flat mode', async () => {
      const pages = [
        makePage({ url: 'https://example.com/docs/api', markdown: '# API', depth: 1 }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Flat mode: docs_api.md relative to INDEX.md (same dir)
      expect(content).toContain('[API](docs_api.md)');
    });
  });

  // -------------------------------------------------------------------------
  // Link format
  // -------------------------------------------------------------------------

  describe('link format', () => {
    it('should use format "- [Title](relative/path.md)"', async () => {
      const pages = [
        makePage({ url: 'https://example.com/page', markdown: '# Page Title', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('- [Page Title](page.md)');
    });

    it('should append description with em dash separator when provided', async () => {
      const pages = [
        makePage({ url: 'https://example.com/page', markdown: '# Page', depth: 0 }),
      ];

      const descriptionProvider = async () => 'A useful page';

      await generator.generate(pages, tmpDir, 'mirror', descriptionProvider);
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Em dash separator: \u2014
      expect(content).toContain('- [Page](page.md) \u2014 A useful page');
    });

    it('should not append description separator when no description', async () => {
      const pages = [
        makePage({ url: 'https://example.com/page', markdown: '# Page', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Should not contain em dash since no description
      expect(content).not.toContain('\u2014');
    });
  });

  // -------------------------------------------------------------------------
  // Title extraction integration
  // -------------------------------------------------------------------------

  describe('title extraction in index', () => {
    it('should use page.title when available', async () => {
      const pages = [
        makePage({
          url: 'https://example.com/page',
          markdown: '# Markdown Title',
          title: 'Explicit Title',
          depth: 0,
        }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('[Explicit Title]');
      expect(content).not.toContain('[Markdown Title]');
    });

    it('should extract title from markdown when page.title is not set', async () => {
      const pages = [
        makePage({
          url: 'https://example.com/page',
          markdown: '# From Markdown',
          depth: 0,
        }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('[From Markdown]');
    });

    it('should use URL-derived title when no heading and no page.title', async () => {
      const pages = [
        makePage({
          url: 'https://example.com/getting-started',
          markdown: 'Just plain text, no heading at all.',
          depth: 0,
        }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('[Getting Started]');
    });
  });

  // -------------------------------------------------------------------------
  // descriptionProvider
  // -------------------------------------------------------------------------

  describe('descriptionProvider', () => {
    it('should call the provider for each page', async () => {
      const pages = [
        makePage({ url: 'https://example.com/a', markdown: '# A', depth: 0 }),
        makePage({ url: 'https://example.com/b', markdown: '# B', depth: 0 }),
      ];

      const calledWith: string[] = [];
      const provider = async (page: FetchedPage) => {
        calledWith.push(page.url);
        return `Description for ${page.url}`;
      };

      await generator.generate(pages, tmpDir, 'flat', provider);

      expect(calledWith).toHaveLength(2);
      expect(calledWith).toContain('https://example.com/a');
      expect(calledWith).toContain('https://example.com/b');
    });

    it('should include descriptions in the output when provider returns values', async () => {
      const pages = [
        makePage({ url: 'https://example.com/guide', markdown: '# Guide', depth: 0 }),
      ];

      const provider = async () => 'Complete API reference';

      await generator.generate(pages, tmpDir, 'flat', provider);
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('Complete API reference');
    });

    it('should be optional and produce valid output without it', async () => {
      const pages = [
        makePage({ url: 'https://example.com/page', markdown: '# Page', depth: 0 }),
      ];

      // No descriptionProvider passed
      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('# Site Index:');
      expect(content).toContain('- [Page]');
      expect(content).toContain('Total: 1 pages fetched');
    });

    it('should silently handle errors from the description provider', async () => {
      const pages = [
        makePage({ url: 'https://example.com/a', markdown: '# A', depth: 0 }),
        makePage({ url: 'https://example.com/b', markdown: '# B', depth: 0 }),
      ];

      const provider = async (page: FetchedPage) => {
        if (page.url.endsWith('/a')) {
          throw new Error('Provider failed');
        }
        return 'Valid description';
      };

      // Should not throw
      await generator.generate(pages, tmpDir, 'flat', provider);
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Page A should have no description (provider error), Page B should
      expect(content).toContain('Valid description');
      // Page A entry should not have em dash since description failed
      const lines = content.split('\n').filter((l) => l.startsWith('- ['));
      const lineA = lines.find((l) => l.includes('[A]'));
      expect(lineA).toBeDefined();
      expect(lineA).not.toContain('\u2014');
    });
  });

  // -------------------------------------------------------------------------
  // Total count accuracy
  // -------------------------------------------------------------------------

  describe('total count', () => {
    it('should show accurate count matching the number of pages', async () => {
      const pages = Array.from({ length: 7 }, (_, i) =>
        makePage({
          url: `https://example.com/page-${i}`,
          markdown: `# Page ${i}`,
          depth: 0,
        }),
      );

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('Total: 7 pages fetched');
    });

    it('should show 0 for empty page list', async () => {
      await generator.generate([], tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('Total: 0 pages fetched');
    });

    it('should show 1 for single page', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('Total: 1 pages fetched');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty page list (no pages fetched)', async () => {
      const result = await generator.generate([], tmpDir, 'mirror');
      const content = await readFile(result, 'utf-8');

      expect(content).toContain('# Site Index: unknown');
      expect(content).toContain('Total: 0 pages fetched');
      // Should not have any entry lines
      const entryLines = content.split('\n').filter((l) => l.trimStart().startsWith('- ['));
      expect(entryLines).toHaveLength(0);
    });

    it('should handle single page correctly', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Welcome', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('# Site Index: example.com');
      expect(content).toContain('[Welcome]');
      expect(content).toContain('Total: 1 pages fetched');
    });

    it('should handle pages at varying depths', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Root', depth: 0 }),
        makePage({ url: 'https://example.com/a', markdown: '# A', depth: 1 }),
        makePage({ url: 'https://example.com/a/b', markdown: '# B', depth: 2 }),
        makePage({ url: 'https://example.com/a/b/c', markdown: '# C', depth: 3 }),
        makePage({ url: 'https://example.com/a/b/c/d', markdown: '# D', depth: 4 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      const entryLines = content.split('\n').filter((l) => l.trimStart().startsWith('- ['));

      expect(entryLines).toHaveLength(5);
      // Verify increasing indentation
      expect(entryLines[0]).toMatch(/^- /);        // depth 0
      expect(entryLines[1]).toMatch(/^  - /);      // depth 1
      expect(entryLines[2]).toMatch(/^    - /);     // depth 2
      expect(entryLines[3]).toMatch(/^      - /);   // depth 3
      expect(entryLines[4]).toMatch(/^        - /); // depth 4
    });

    it('should handle pages with no markdown heading (use URL-derived title)', async () => {
      const pages = [
        makePage({
          url: 'https://example.com/user-guide',
          markdown: 'This page has no heading whatsoever.',
          depth: 0,
        }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Should derive title from URL
      expect(content).toContain('[User Guide]');
    });

    it('should handle root URL page in flat mode', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('[Home](index.md)');
    });

    it('should handle root URL page in mirror mode', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'mirror');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      expect(content).toContain('[Home](index.md)');
    });

    it('should compute common path prefix for domain header', async () => {
      const pages = [
        makePage({ url: 'https://example.com/docs/api', markdown: '# API', depth: 0 }),
        makePage({ url: 'https://example.com/docs/guide', markdown: '# Guide', depth: 0 }),
      ];

      await generator.generate(pages, tmpDir, 'flat');
      const content = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');

      // Common prefix is /docs, so domain should be example.com/docs
      expect(content).toContain('# Site Index: example.com/docs');
    });

    it('should handle pages with descriptions in both mirror and flat modes', async () => {
      const pages = [
        makePage({ url: 'https://example.com/a', markdown: '# A', depth: 0 }),
        makePage({ url: 'https://example.com/a/b', markdown: '# B', depth: 1 }),
      ];
      const provider = async (page: FetchedPage) => `Desc for ${page.url.split('/').pop()}`;

      // Mirror mode
      await generator.generate(pages, tmpDir, 'mirror', provider);
      const mirrorContent = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      expect(mirrorContent).toContain('\u2014 Desc for a');
      expect(mirrorContent).toContain('\u2014 Desc for b');

      // Flat mode (overwrite INDEX.md)
      await generator.generate(pages, tmpDir, 'flat', provider);
      const flatContent = await readFile(join(tmpDir, 'INDEX.md'), 'utf-8');
      expect(flatContent).toContain('\u2014 Desc for a');
      expect(flatContent).toContain('\u2014 Desc for b');
    });

    it('should return the index file path from generate()', async () => {
      const pages = [
        makePage({ url: 'https://example.com/', markdown: '# Home', depth: 0 }),
      ];

      const result = await generator.generate(pages, tmpDir, 'flat');
      expect(result).toBe(join(tmpDir, 'INDEX.md'));
    });
  });
});

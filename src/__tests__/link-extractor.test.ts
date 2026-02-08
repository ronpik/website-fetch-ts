import { describe, it, expect } from 'vitest';
import { extractLinks } from '../fetcher/link-extractor.js';

const BASE_URL = 'https://example.com/page';

/**
 * Helper to build a minimal HTML document with the given body content.
 */
function html(body: string): string {
  return `<!DOCTYPE html><html><head><title>Test</title></head><body>${body}</body></html>`;
}

describe('extractLinks', () => {
  describe('basic extraction', () => {
    it('should extract links from simple HTML with correct URLs and text', () => {
      const page = html(`
        <p>Check out <a href="/about">About Us</a> for more info.</p>
        <p>Visit <a href="/contact">Contact Page</a> to reach us.</p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(2);
      expect(links[0]).toMatchObject({
        url: 'https://example.com/about',
        text: 'About Us',
      });
      expect(links[1]).toMatchObject({
        url: 'https://example.com/contact',
        text: 'Contact Page',
      });
    });

    it('should resolve relative URLs to absolute', () => {
      const page = html(`
        <p><a href="/docs/guide">Guide</a></p>
        <p><a href="sibling-page">Sibling</a></p>
        <p><a href="../other">Other</a></p>
        <p><a href="https://example.com/absolute">Absolute</a></p>
      `);

      const links = extractLinks(page, 'https://example.com/section/page');

      expect(links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://example.com/docs/guide' }),
          expect.objectContaining({ url: 'https://example.com/section/sibling-page' }),
          expect.objectContaining({ url: 'https://example.com/other' }),
          expect.objectContaining({ url: 'https://example.com/absolute' }),
        ]),
      );
    });

    it('should extract surrounding paragraph text as context', () => {
      const page = html(`
        <p>This is a paragraph with a <a href="/link">link here</a> inside it.</p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].context).toContain('This is a paragraph with a');
      expect(links[0].context).toContain('link here');
      expect(links[0].context).toContain('inside it.');
    });

    it('should truncate context to approximately 200 characters', () => {
      const longText = 'A'.repeat(300);
      const page = html(`
        <p>${longText} <a href="/link">click</a> ${longText}</p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].context.length).toBeLessThanOrEqual(200);
    });
  });

  describe('same-domain filtering', () => {
    it('should filter out cross-domain links when sameDomainOnly is true (default)', () => {
      const page = html(`
        <p><a href="https://example.com/internal">Internal</a></p>
        <p><a href="https://other.com/external">External</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/internal');
    });

    it('should include cross-domain links when sameDomainOnly is false', () => {
      const page = html(`
        <p><a href="https://example.com/internal">Internal</a></p>
        <p><a href="https://other.com/external">External</a></p>
      `);

      const links = extractLinks(page, BASE_URL, { sameDomainOnly: false });

      expect(links).toHaveLength(2);
      expect(links.map((l) => l.url)).toEqual(
        expect.arrayContaining([
          'https://example.com/internal',
          'https://other.com/external',
        ]),
      );
    });
  });

  describe('include pattern filtering', () => {
    it('should only return URLs matching include pattern', () => {
      const page = html(`
        <p><a href="/docs/api">API Docs</a></p>
        <p><a href="/docs/guide">Guide</a></p>
        <p><a href="/blog/post-1">Blog Post</a></p>
      `);

      const links = extractLinks(page, BASE_URL, {
        includePatterns: ['/docs/*'],
      });

      expect(links).toHaveLength(2);
      expect(links.every((l) => l.url.includes('/docs/'))).toBe(true);
    });

    it('should support ** glob pattern for deep matching', () => {
      const page = html(`
        <p><a href="/docs/v1/api/auth">Auth API</a></p>
        <p><a href="/docs/v2/guide/start">Start Guide</a></p>
        <p><a href="/blog/post">Blog</a></p>
      `);

      const links = extractLinks(page, BASE_URL, {
        includePatterns: ['/docs/**'],
      });

      expect(links).toHaveLength(2);
      expect(links.every((l) => l.url.includes('/docs/'))).toBe(true);
    });
  });

  describe('exclude pattern filtering', () => {
    it('should remove URLs matching exclude pattern', () => {
      const page = html(`
        <p><a href="/docs/api">API Docs</a></p>
        <p><a href="/blog/post-1">Blog Post</a></p>
        <p><a href="/about">About</a></p>
      `);

      const links = extractLinks(page, BASE_URL, {
        excludePatterns: ['/blog/*'],
      });

      expect(links).toHaveLength(2);
      expect(links.every((l) => !l.url.includes('/blog/'))).toBe(true);
    });

    it('should support ** glob pattern in exclude for deep matching', () => {
      const page = html(`
        <p><a href="/admin/settings">Settings</a></p>
        <p><a href="/admin/users/list">Users</a></p>
        <p><a href="/docs/guide">Guide</a></p>
      `);

      const links = extractLinks(page, BASE_URL, {
        excludePatterns: ['/admin/**'],
      });

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/docs/guide');
    });
  });

  describe('deduplication', () => {
    it('should deduplicate links by URL, keeping first occurrence', () => {
      const page = html(`
        <p>First mention: <a href="/page-a">Link A first</a></p>
        <p>Second mention: <a href="/page-a">Link A second</a></p>
        <p>Third: <a href="/page-b">Link B</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(2);

      const linkA = links.find((l) => l.url === 'https://example.com/page-a');
      expect(linkA).toBeDefined();
      expect(linkA!.text).toBe('Link A first');
    });
  });

  describe('edge cases - skipped links', () => {
    it('should skip links with no href attribute', () => {
      const page = html(`
        <p><a>No href</a></p>
        <p><a name="anchor">Named anchor</a></p>
        <p><a href="/valid">Valid Link</a></p>
      `);

      // Note: jsdom's querySelectorAll('a[href]') will only select anchors
      // with the href attribute present, so the first two anchors are skipped.
      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/valid');
    });

    it('should skip links with empty href', () => {
      const page = html(`
        <p><a href="">Empty href</a></p>
        <p><a href="   ">Whitespace href</a></p>
        <p><a href="/valid">Valid</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/valid');
    });

    it('should skip fragment-only links (#section)', () => {
      const page = html(`
        <p><a href="#top">Back to top</a></p>
        <p><a href="#section-1">Section 1</a></p>
        <p><a href="/valid#section">Valid with fragment</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      // Note: implementation strips fragments from URLs
      expect(links[0].url).toBe('https://example.com/valid');
    });

    it('should skip mailto: links', () => {
      const page = html(`
        <p><a href="mailto:user@example.com">Email Us</a></p>
        <p><a href="/valid">Valid</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/valid');
    });

    it('should skip javascript: links', () => {
      const page = html(`
        <p><a href="javascript:void(0)">JS Link</a></p>
        <p><a href="javascript:alert('hi')">Alert</a></p>
        <p><a href="/valid">Valid</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/valid');
    });

    it('should skip tel: links', () => {
      const page = html(`
        <p><a href="tel:+1234567890">Call Us</a></p>
        <p><a href="/valid">Valid</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/valid');
    });

    it('should skip malformed URLs gracefully', () => {
      const page = html(`
        <p><a href="://broken">Broken URL</a></p>
        <p><a href="/valid">Valid</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      // The malformed URL should be skipped without throwing an error
      const validLinks = links.filter((l) => l.url === 'https://example.com/valid');
      expect(validLinks).toHaveLength(1);
    });
  });

  describe('edge cases - structural', () => {
    it('should extract links inside <nav> elements', () => {
      const page = html(`
        <nav>
          <a href="/home">Home</a>
          <a href="/about">About</a>
        </nav>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(2);
      expect(links.map((l) => l.url)).toEqual(
        expect.arrayContaining([
          'https://example.com/home',
          'https://example.com/about',
        ]),
      );
    });

    it('should extract links inside <footer> elements', () => {
      const page = html(`
        <footer>
          <p>Copyright 2024. <a href="/privacy">Privacy Policy</a></p>
          <p><a href="/terms">Terms of Service</a></p>
        </footer>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(2);
      expect(links.map((l) => l.url)).toEqual(
        expect.arrayContaining([
          'https://example.com/privacy',
          'https://example.com/terms',
        ]),
      );
    });

    it('should return empty array when HTML has no links', () => {
      const page = html(`
        <p>This is a page with no links at all.</p>
        <p>Just plain text content.</p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toEqual([]);
    });

    it('should return empty array when pageUrl is malformed', () => {
      const page = html(`<p><a href="/link">Link</a></p>`);

      const links = extractLinks(page, 'not-a-valid-url');

      expect(links).toEqual([]);
    });
  });

  describe('context extraction', () => {
    it('should extract context from parent <li> element', () => {
      const page = html(`
        <ul>
          <li>Check out the <a href="/docs">documentation</a> for details.</li>
        </ul>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].context).toContain('Check out the');
      expect(links[0].context).toContain('documentation');
      expect(links[0].context).toContain('for details.');
    });

    it('should extract context from parent heading element', () => {
      const page = html(`
        <h2><a href="/section">Section Title</a></h2>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].context).toContain('Section Title');
    });

    it('should use the anchor text itself as context when no block parent found', () => {
      // A link directly in <body> with no block-level parent
      const page = `<!DOCTYPE html><html><body><a href="/orphan">Orphan Link</a></body></html>`;

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].text).toBe('Orphan Link');
      // Context should at minimum contain the link text
      expect(links[0].context).toContain('Orphan Link');
    });
  });

  describe('URL normalization', () => {
    it('should strip fragment from URLs', () => {
      const page = html(`
        <p><a href="/page#section">With Fragment</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/page');
      expect(links[0].url).not.toContain('#');
    });

    it('should strip query parameters from URLs', () => {
      // Implementation strips query params per current behavior
      const page = html(`
        <p><a href="/search?q=test">Search</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/search');
    });

    it('should deduplicate URLs that differ only by fragment', () => {
      const page = html(`
        <p><a href="/page#section-1">Section 1</a></p>
        <p><a href="/page#section-2">Section 2</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/page');
      // First occurrence's text is kept
      expect(links[0].text).toBe('Section 1');
    });
  });

  describe('combined options', () => {
    it('should apply both include and exclude patterns together', () => {
      const page = html(`
        <p><a href="/docs/api">API</a></p>
        <p><a href="/docs/internal">Internal Docs</a></p>
        <p><a href="/blog/post">Blog</a></p>
      `);

      const links = extractLinks(page, BASE_URL, {
        includePatterns: ['/docs/*'],
        excludePatterns: ['/docs/internal'],
      });

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/docs/api');
    });

    it('should apply same-domain filter together with include patterns', () => {
      const page = html(`
        <p><a href="https://example.com/docs/guide">Internal Doc</a></p>
        <p><a href="https://other.com/docs/guide">External Doc</a></p>
      `);

      const links = extractLinks(page, BASE_URL, {
        sameDomainOnly: true,
        includePatterns: ['/docs/*'],
      });

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/docs/guide');
    });
  });

  describe('scheme handling', () => {
    it('should be case-insensitive when checking excluded schemes', () => {
      const page = html(`
        <p><a href="MAILTO:user@example.com">Email</a></p>
        <p><a href="JavaScript:void(0)">JS</a></p>
        <p><a href="/valid">Valid</a></p>
      `);

      const links = extractLinks(page, BASE_URL);

      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/valid');
    });
  });
});

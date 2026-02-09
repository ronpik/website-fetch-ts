import { JSDOM } from 'jsdom';

/**
 * A link extracted from an HTML page with its surrounding context.
 */
export interface ExtractedLink {
  /** Absolute URL of the link target. */
  url: string;
  /** The link text itself. */
  text: string;
  /** Surrounding paragraph/element text (~200 chars max). */
  context: string;
}

/**
 * Options for link extraction and filtering.
 */
export interface ExtractLinksOptions {
  /** Only include links to the same domain as pageUrl. Defaults to true. */
  sameDomainOnly?: boolean;
  /** Glob-style patterns; only URLs matching at least one are included. */
  includePatterns?: string[];
  /** Glob-style patterns; URLs matching any of these are excluded. */
  excludePatterns?: string[];
  /** Only include URLs whose pathname starts with this prefix. */
  pathPrefix?: string;
}

/** Maximum length for the context string. */
const MAX_CONTEXT_LENGTH = 200;

/** URL schemes to exclude. */
const EXCLUDED_SCHEMES = ['mailto:', 'javascript:', 'tel:', 'data:'];

/**
 * Convert a glob-style pattern to a RegExp.
 *
 * Supports:
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/`
 * - `?` matches a single character
 * - All other regex special chars are escaped
 *
 * The pattern is matched against the URL's pathname.
 */
function globToRegex(pattern: string): RegExp {
  // Escape regex special characters except * and ?
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      // ** matches anything including /
      regexStr += '.*';
      i += 2;
      // Skip a trailing slash after ** (e.g., /**/foo matches /a/b/foo)
      if (pattern[i] === '/') {
        regexStr += '(?:/|$)';
        i++;
      }
    } else if (char === '*') {
      // * matches anything except /
      regexStr += '[^/]*';
      i++;
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      regexStr += '\\' + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }
  return new RegExp('^' + regexStr + '$');
}

/**
 * Test whether a URL's pathname matches a glob pattern.
 */
function matchesPattern(url: URL, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(url.pathname);
}

/**
 * Get the nearest meaningful parent element's text content.
 * Walks up from the link to find a paragraph, list item, heading,
 * table cell, or similar block-level container.
 */
function getContext(anchor: Element): string {
  const blockTags = new Set([
    'P', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'ARTICLE',
    'SECTION', 'DIV', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'MAIN',
  ]);

  let current: Element | null = anchor.parentElement;
  while (current) {
    if (blockTags.has(current.tagName)) {
      break;
    }
    current = current.parentElement;
  }

  // If no block parent found, use the anchor itself
  const contextElement = current ?? anchor;
  const text = (contextElement.textContent ?? '').replace(/\s+/g, ' ').trim();

  if (text.length <= MAX_CONTEXT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_CONTEXT_LENGTH);
}

/**
 * Extract links from an HTML page with their text and surrounding context.
 *
 * @param html - The raw HTML string
 * @param pageUrl - The URL of the page (used to resolve relative URLs and for same-domain filtering)
 * @param options - Filtering options
 * @returns Array of extracted links, deduplicated by URL
 */
export function extractLinks(
  html: string,
  pageUrl: string,
  options?: ExtractLinksOptions,
): ExtractedLink[] {
  const sameDomainOnly = options?.sameDomainOnly ?? true;
  const includePatterns = options?.includePatterns;
  const excludePatterns = options?.excludePatterns;
  let pathPrefix = options?.pathPrefix;
  if (pathPrefix && !pathPrefix.startsWith('/')) {
    pathPrefix = '/' + pathPrefix;
  }

  let pageUrlParsed: URL;
  try {
    pageUrlParsed = new URL(pageUrl);
  } catch {
    return [];
  }

  const dom = new JSDOM(html, { url: pageUrl });
  const document = dom.window.document;
  const anchors = document.querySelectorAll('a[href]');

  const seen = new Map<string, ExtractedLink>();
  const results: ExtractedLink[] = [];

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href');

    // Skip empty or missing href
    if (!href || href.trim() === '') {
      continue;
    }

    const trimmedHref = href.trim();

    // Skip fragment-only links
    if (trimmedHref.startsWith('#')) {
      continue;
    }

    // Skip excluded schemes
    const lowerHref = trimmedHref.toLowerCase();
    if (EXCLUDED_SCHEMES.some((scheme) => lowerHref.startsWith(scheme))) {
      continue;
    }

    // Resolve relative URL to absolute
    let resolved: URL;
    try {
      resolved = new URL(trimmedHref, pageUrl);
    } catch {
      // Malformed URL - skip gracefully
      continue;
    }

    // Only keep http/https links
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      continue;
    }

    // Strip fragment and query params
    resolved.hash = '';
    resolved.search = '';

    const absoluteUrl = resolved.href;

    // Same-domain filtering
    if (sameDomainOnly && resolved.hostname !== pageUrlParsed.hostname) {
      continue;
    }

    // Path prefix filtering
    if (pathPrefix) {
      const pathname = resolved.pathname;
      if (!pathname.startsWith(pathPrefix)) {
        continue;
      }
      // Ensure the prefix matches at a path boundary:
      // either the pathname equals the prefix exactly, the prefix ends with '/',
      // or the character after the prefix is '/'.
      if (
        pathname.length > pathPrefix.length &&
        !pathPrefix.endsWith('/') &&
        pathname[pathPrefix.length] !== '/'
      ) {
        continue;
      }
    }

    // Include pattern filtering
    if (includePatterns && includePatterns.length > 0) {
      const matches = includePatterns.some((p) => matchesPattern(resolved, p));
      if (!matches) {
        continue;
      }
    }

    // Exclude pattern filtering
    if (excludePatterns && excludePatterns.length > 0) {
      const matches = excludePatterns.some((p) => matchesPattern(resolved, p));
      if (matches) {
        continue;
      }
    }

    // Deduplicate by URL (keep first occurrence)
    if (seen.has(absoluteUrl)) {
      continue;
    }

    const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
    const context = getContext(anchor);

    const link: ExtractedLink = {
      url: absoluteUrl,
      text,
      context,
    };

    seen.set(absoluteUrl, link);
    results.push(link);
  }

  return results;
}

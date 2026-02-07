import { join } from 'node:path';

/**
 * Extract the pathname from a URL, stripping query parameters and fragments.
 * Returns a decoded path string (e.g., "/docs/api/auth").
 */
export function urlToPath(url: string): string {
  const parsed = new URL(url);
  // Use pathname only (strips query and fragment)
  let pathname = decodeURIComponent(parsed.pathname);

  // Remove trailing slash for non-root paths, then we'll handle mapping
  // Keep as-is for now; callers decide on trailing slash semantics
  return pathname;
}

/**
 * Sanitize a filename component to be filesystem-safe.
 * Removes or replaces characters that are problematic on common file systems.
 */
export function sanitizeFilename(name: string): string {
  // Replace characters not safe for filenames
  let sanitized = name
    .replace(/[<>:"|?*\\]/g, '_')  // Windows-unsafe chars
    .replace(/\0/g, '')             // null bytes
    .replace(/\.{2,}/g, '.')        // collapse multiple dots
    .trim();

  // Truncate overly long filenames (keep well under 255-char limit)
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  return sanitized;
}

/**
 * Build a YAML front matter block and prepend it to markdown content.
 *
 * @param markdown - The markdown body
 * @param metadata - Key-value pairs to include in front matter
 * @returns Markdown string with front matter prepended
 */
export function addFrontMatter(
  markdown: string,
  metadata: Record<string, string>,
): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');
  lines.push('');

  return lines.join('\n') + markdown;
}

/**
 * Convert a URL pathname into a mirror-mode file path under the given output directory.
 *
 * Mapping rules:
 * - `/` -> `<outputDir>/index.md`
 * - `/docs/` -> `<outputDir>/docs/index.md`
 * - `/docs/api/auth` -> `<outputDir>/docs/api/auth.md`
 */
export function pathToMirrorFile(urlPath: string, outputDir: string): string {
  // Strip leading slash
  let rel = urlPath.startsWith('/') ? urlPath.substring(1) : urlPath;

  // If empty or ends with '/', it's an index page
  if (rel === '' || rel.endsWith('/')) {
    rel = rel + 'index.md';
  } else {
    // Append .md extension
    // If path already ends with a file extension, replace it
    rel = rel + '.md';
  }

  // Sanitize each path segment
  const segments = rel.split('/').map((seg) => sanitizeFilename(seg));
  return join(outputDir, ...segments);
}

/**
 * Convert a URL pathname into a flat-mode file path under the given output directory.
 *
 * Mapping rules:
 * - `/` -> `<outputDir>/index.md`
 * - `/docs/api/auth` -> `<outputDir>/docs_api_auth.md`
 * - `/docs/` -> `<outputDir>/docs_index.md`
 */
export function pathToFlatFile(urlPath: string, outputDir: string): string {
  // Strip leading slash
  let rel = urlPath.startsWith('/') ? urlPath.substring(1) : urlPath;

  // Handle root or trailing slash
  if (rel === '') {
    return join(outputDir, 'index.md');
  }

  // If ends with '/', append 'index' before joining
  if (rel.endsWith('/')) {
    rel = rel + 'index';
  }

  // Replace path separators with underscores
  const flatName = sanitizeFilename(rel.replace(/\//g, '_'));
  return join(outputDir, flatName + '.md');
}

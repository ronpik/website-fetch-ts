import { readFileSync } from 'node:fs';

/**
 * A parsed cookie from a Netscape-format cookie file.
 */
export interface Cookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expiry: number;
  name: string;
  value: string;
}

/**
 * Load cookies from a Netscape-format cookie file.
 *
 * Format: domain\tTRUE\tpath\tTRUE\texpiry\tname\tvalue
 * Lines starting with '#' or blank lines are ignored.
 *
 * @param filePath - Path to the cookie file
 * @returns Array of parsed cookies
 */
export function loadCookieFile(filePath: string): Cookie[] {
  const content = readFileSync(filePath, 'utf-8');
  const cookies: Cookie[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const fields = trimmed.split('\t');
    if (fields.length < 7) {
      continue;
    }

    cookies.push({
      domain: fields[0],
      includeSubdomains: fields[1].toUpperCase() === 'TRUE',
      path: fields[2],
      secure: fields[3].toUpperCase() === 'TRUE',
      expiry: parseInt(fields[4], 10),
      name: fields[5],
      value: fields[6],
    });
  }

  return cookies;
}

/**
 * Match cookies from a loaded cookie file to a specific request URL.
 * Returns a `Cookie` header string suitable for HTTP requests.
 *
 * @param cookies - Parsed cookies from loadCookieFile
 * @param url - The request URL to match against
 * @returns Cookie header string (e.g., "name1=value1; name2=value2") or empty string
 */
export function matchCookies(cookies: Cookie[], url: string): string {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const pathname = parsed.pathname;
  const isSecure = parsed.protocol === 'https:';
  const now = Math.floor(Date.now() / 1000);

  const matched = cookies.filter((cookie) => {
    // Check domain match
    if (!domainMatches(hostname, cookie.domain, cookie.includeSubdomains)) {
      return false;
    }

    // Check path match
    if (!pathname.startsWith(cookie.path)) {
      return false;
    }

    // Check secure flag
    if (cookie.secure && !isSecure) {
      return false;
    }

    // Check expiry (0 means session cookie - always valid)
    if (cookie.expiry !== 0 && cookie.expiry < now) {
      return false;
    }

    return true;
  });

  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Check if a hostname matches a cookie domain.
 */
function domainMatches(
  hostname: string,
  cookieDomain: string,
  includeSubdomains: boolean,
): boolean {
  // Strip leading dot from cookie domain
  const domain = cookieDomain.startsWith('.')
    ? cookieDomain.substring(1)
    : cookieDomain;

  if (hostname === domain) {
    return true;
  }

  if (includeSubdomains && hostname.endsWith('.' + domain)) {
    return true;
  }

  return false;
}

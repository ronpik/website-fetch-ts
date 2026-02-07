import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCookieFile, matchCookies, type Cookie } from "../fetcher/cookies.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for cookie files. */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cookie-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write a cookie file with given lines and return the path. */
async function writeCookieFile(lines: string[]): Promise<string> {
  const filePath = join(tempDir, "cookies.txt");
  await writeFile(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// 1. loadCookieFile
// ---------------------------------------------------------------------------
describe("loadCookieFile", () => {
  it("should parse a valid Netscape-format cookie file", async () => {
    const filePath = await writeCookieFile([
      "# Netscape HTTP Cookie File",
      ".example.com\tTRUE\t/\tFALSE\t0\tsession_id\tabc123",
    ]);

    const cookies = loadCookieFile(filePath);

    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toEqual({
      domain: ".example.com",
      includeSubdomains: true,
      path: "/",
      secure: false,
      expiry: 0,
      name: "session_id",
      value: "abc123",
    });
  });

  it("should parse multiple cookies", async () => {
    const filePath = await writeCookieFile([
      ".example.com\tTRUE\t/\tFALSE\t0\tsession_id\tabc123",
      ".example.com\tTRUE\t/\tTRUE\t1893456000\tauth_token\txyz789",
      "other.com\tFALSE\t/api\tFALSE\t0\tapi_key\tkey123",
    ]);

    const cookies = loadCookieFile(filePath);

    expect(cookies).toHaveLength(3);
    expect(cookies[0].name).toBe("session_id");
    expect(cookies[1].name).toBe("auth_token");
    expect(cookies[1].secure).toBe(true);
    expect(cookies[2].domain).toBe("other.com");
    expect(cookies[2].includeSubdomains).toBe(false);
    expect(cookies[2].path).toBe("/api");
  });

  it("should skip comment lines starting with #", async () => {
    const filePath = await writeCookieFile([
      "# This is a comment",
      "# Another comment",
      ".example.com\tTRUE\t/\tFALSE\t0\tname\tvalue",
    ]);

    const cookies = loadCookieFile(filePath);
    expect(cookies).toHaveLength(1);
  });

  it("should skip empty lines", async () => {
    const filePath = await writeCookieFile([
      "",
      ".example.com\tTRUE\t/\tFALSE\t0\tname\tvalue",
      "",
      "",
      "other.com\tFALSE\t/\tFALSE\t0\tother\tval",
      "",
    ]);

    const cookies = loadCookieFile(filePath);
    expect(cookies).toHaveLength(2);
  });

  it("should skip lines with fewer than 7 tab-separated fields", async () => {
    const filePath = await writeCookieFile([
      ".example.com\tTRUE\t/\tFALSE\t0\tname", // only 6 fields
      ".example.com\tTRUE\t/\tFALSE\t0\tgood_name\tgood_value", // 7 fields
    ]);

    const cookies = loadCookieFile(filePath);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe("good_name");
  });

  it("should handle secure flag correctly (TRUE/FALSE)", async () => {
    const filePath = await writeCookieFile([
      ".example.com\tTRUE\t/\tTRUE\t0\tsecure_cookie\tval1",
      ".example.com\tTRUE\t/\tFALSE\t0\tinsecure_cookie\tval2",
    ]);

    const cookies = loadCookieFile(filePath);
    expect(cookies[0].secure).toBe(true);
    expect(cookies[1].secure).toBe(false);
  });

  it("should parse expiry as integer", async () => {
    const filePath = await writeCookieFile([
      ".example.com\tTRUE\t/\tFALSE\t1893456000\texpiring\tval",
    ]);

    const cookies = loadCookieFile(filePath);
    expect(cookies[0].expiry).toBe(1893456000);
    expect(typeof cookies[0].expiry).toBe("number");
  });

  it("should return empty array for empty cookie file", async () => {
    const filePath = await writeCookieFile([""]);

    const cookies = loadCookieFile(filePath);
    expect(cookies).toHaveLength(0);
  });

  it("should return empty array for comment-only cookie file", async () => {
    const filePath = await writeCookieFile([
      "# Netscape HTTP Cookie File",
      "# This file has no cookies",
    ]);

    const cookies = loadCookieFile(filePath);
    expect(cookies).toHaveLength(0);
  });

  it("should throw when file does not exist", () => {
    expect(() => loadCookieFile("/nonexistent/cookies.txt")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. matchCookies
// ---------------------------------------------------------------------------
describe("matchCookies", () => {
  const baseCookies: Cookie[] = [
    {
      domain: ".example.com",
      includeSubdomains: true,
      path: "/",
      secure: false,
      expiry: 0,
      name: "session",
      value: "abc123",
    },
    {
      domain: ".example.com",
      includeSubdomains: true,
      path: "/",
      secure: true,
      expiry: 0,
      name: "secure_token",
      value: "sec456",
    },
    {
      domain: "other.com",
      includeSubdomains: false,
      path: "/api",
      secure: false,
      expiry: 0,
      name: "api_key",
      value: "key789",
    },
  ];

  it("should match cookies by domain", () => {
    const result = matchCookies(baseCookies, "https://example.com/page");
    expect(result).toContain("session=abc123");
    expect(result).toContain("secure_token=sec456");
    expect(result).not.toContain("api_key");
  });

  it("should match cookies for subdomains when includeSubdomains is true", () => {
    const result = matchCookies(
      baseCookies,
      "https://sub.example.com/page",
    );
    expect(result).toContain("session=abc123");
  });

  it("should not match subdomain cookies when includeSubdomains is false", () => {
    const result = matchCookies(
      baseCookies,
      "https://sub.other.com/api/endpoint",
    );
    expect(result).not.toContain("api_key");
  });

  it("should match exact domain when includeSubdomains is false", () => {
    const result = matchCookies(baseCookies, "http://other.com/api/endpoint");
    expect(result).toContain("api_key=key789");
  });

  it("should match cookies by path prefix", () => {
    const result = matchCookies(baseCookies, "http://other.com/api/v1/data");
    expect(result).toContain("api_key=key789");
  });

  it("should not match cookies when path does not match", () => {
    const result = matchCookies(baseCookies, "http://other.com/web/page");
    expect(result).not.toContain("api_key");
  });

  it("should not send secure cookies over http", () => {
    const result = matchCookies(baseCookies, "http://example.com/page");
    expect(result).toContain("session=abc123");
    expect(result).not.toContain("secure_token");
  });

  it("should send secure cookies over https", () => {
    const result = matchCookies(baseCookies, "https://example.com/page");
    expect(result).toContain("secure_token=sec456");
  });

  it("should not match expired cookies", () => {
    const expiredCookies: Cookie[] = [
      {
        domain: ".example.com",
        includeSubdomains: true,
        path: "/",
        secure: false,
        expiry: 1, // expired in 1970
        name: "old_cookie",
        value: "expired",
      },
    ];

    const result = matchCookies(expiredCookies, "https://example.com/page");
    expect(result).toBe("");
  });

  it("should match session cookies (expiry 0) regardless of time", () => {
    const sessionCookies: Cookie[] = [
      {
        domain: ".example.com",
        includeSubdomains: true,
        path: "/",
        secure: false,
        expiry: 0,
        name: "session",
        value: "active",
      },
    ];

    const result = matchCookies(sessionCookies, "https://example.com/page");
    expect(result).toBe("session=active");
  });

  it("should match cookies with far-future expiry", () => {
    const futureCookies: Cookie[] = [
      {
        domain: ".example.com",
        includeSubdomains: true,
        path: "/",
        secure: false,
        expiry: 4102444800, // year 2100
        name: "future",
        value: "valid",
      },
    ];

    const result = matchCookies(futureCookies, "https://example.com/page");
    expect(result).toBe("future=valid");
  });

  it("should format multiple matched cookies with semicolon separator", () => {
    const result = matchCookies(baseCookies, "https://example.com/page");
    // Should have session and secure_token separated by "; "
    expect(result).toBe("session=abc123; secure_token=sec456");
  });

  it("should return empty string when no cookies match", () => {
    const result = matchCookies(baseCookies, "https://unrelated.com/page");
    expect(result).toBe("");
  });

  it("should handle cookie domain with leading dot", () => {
    const cookies: Cookie[] = [
      {
        domain: ".example.com",
        includeSubdomains: true,
        path: "/",
        secure: false,
        expiry: 0,
        name: "dotted",
        value: "yes",
      },
    ];

    const result = matchCookies(cookies, "https://example.com/page");
    expect(result).toBe("dotted=yes");
  });

  it("should return empty string for empty cookies array", () => {
    const result = matchCookies([], "https://example.com/page");
    expect(result).toBe("");
  });
});

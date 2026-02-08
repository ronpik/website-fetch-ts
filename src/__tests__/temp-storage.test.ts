import { describe, it, expect, beforeEach } from "vitest";
import { TempStorage } from "../crawler/temp-storage.js";
import type { FetchedPageRaw } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(url: string, html: string = "<html><body>test</body></html>"): FetchedPageRaw {
  return {
    url,
    html,
    statusCode: 200,
    headers: { "content-type": "text/html" },
    fetchedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// TempStorage Tests
// ---------------------------------------------------------------------------
describe("TempStorage", () => {
  let storage: TempStorage;

  beforeEach(() => {
    storage = new TempStorage();
  });

  // -------------------------------------------------------------------------
  // store / get
  // -------------------------------------------------------------------------
  describe("store and get", () => {
    it("should store and retrieve a page entry", () => {
      const raw = makeRaw("https://example.com");
      storage.store("https://example.com", raw, "# Hello");

      const entry = storage.get("https://example.com");
      expect(entry).toBeDefined();
      expect(entry!.raw).toBe(raw);
      expect(entry!.markdown).toBe("# Hello");
    });

    it("should return undefined for a URL that was never stored", () => {
      expect(storage.get("https://example.com/missing")).toBeUndefined();
    });

    it("should overwrite existing entry when storing same URL", () => {
      const raw1 = makeRaw("https://example.com");
      const raw2 = makeRaw("https://example.com");
      storage.store("https://example.com", raw1, "# First");
      storage.store("https://example.com", raw2, "# Second");

      const entry = storage.get("https://example.com");
      expect(entry!.raw).toBe(raw2);
      expect(entry!.markdown).toBe("# Second");
    });

    it("should store multiple entries with different URLs", () => {
      storage.store("https://example.com/a", makeRaw("https://example.com/a"), "# A");
      storage.store("https://example.com/b", makeRaw("https://example.com/b"), "# B");

      expect(storage.get("https://example.com/a")).toBeDefined();
      expect(storage.get("https://example.com/b")).toBeDefined();
      expect(storage.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // has
  // -------------------------------------------------------------------------
  describe("has", () => {
    it("should return true for a stored URL", () => {
      storage.store("https://example.com", makeRaw("https://example.com"), "# test");
      expect(storage.has("https://example.com")).toBe(true);
    });

    it("should return false for an unstored URL", () => {
      expect(storage.has("https://example.com/missing")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------
  describe("remove", () => {
    it("should remove an existing entry and return true", () => {
      storage.store("https://example.com", makeRaw("https://example.com"), "# test");

      const removed = storage.remove("https://example.com");
      expect(removed).toBe(true);
      expect(storage.has("https://example.com")).toBe(false);
      expect(storage.get("https://example.com")).toBeUndefined();
    });

    it("should return false when removing a non-existent URL", () => {
      expect(storage.remove("https://example.com/missing")).toBe(false);
    });

    it("should only remove the specified URL, not others", () => {
      storage.store("https://example.com/a", makeRaw("https://example.com/a"), "# A");
      storage.store("https://example.com/b", makeRaw("https://example.com/b"), "# B");

      storage.remove("https://example.com/a");
      expect(storage.has("https://example.com/a")).toBe(false);
      expect(storage.has("https://example.com/b")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // size
  // -------------------------------------------------------------------------
  describe("size", () => {
    it("should return 0 for empty storage", () => {
      expect(storage.size).toBe(0);
    });

    it("should reflect the number of stored entries", () => {
      storage.store("https://example.com/a", makeRaw("https://example.com/a"), "# A");
      expect(storage.size).toBe(1);

      storage.store("https://example.com/b", makeRaw("https://example.com/b"), "# B");
      expect(storage.size).toBe(2);

      storage.remove("https://example.com/a");
      expect(storage.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // urls
  // -------------------------------------------------------------------------
  describe("urls", () => {
    it("should return empty array for empty storage", () => {
      expect(storage.urls()).toEqual([]);
    });

    it("should return all stored URLs", () => {
      storage.store("https://example.com/a", makeRaw("https://example.com/a"), "# A");
      storage.store("https://example.com/b", makeRaw("https://example.com/b"), "# B");

      const urls = storage.urls();
      expect(urls).toHaveLength(2);
      expect(urls).toContain("https://example.com/a");
      expect(urls).toContain("https://example.com/b");
    });

    it("should not include removed URLs", () => {
      storage.store("https://example.com/a", makeRaw("https://example.com/a"), "# A");
      storage.store("https://example.com/b", makeRaw("https://example.com/b"), "# B");
      storage.remove("https://example.com/a");

      const urls = storage.urls();
      expect(urls).toHaveLength(1);
      expect(urls).toContain("https://example.com/b");
    });
  });

  // -------------------------------------------------------------------------
  // getLinks
  // -------------------------------------------------------------------------
  describe("getLinks", () => {
    it("should return empty array for non-existent URL", () => {
      const links = storage.getLinks("https://example.com/missing");
      expect(links).toEqual([]);
    });

    it("should extract links from stored page HTML", () => {
      const html = `<html><body>
        <p><a href="https://example.com/about">About</a></p>
        <p><a href="https://example.com/docs">Docs</a></p>
      </body></html>`;
      storage.store("https://example.com", makeRaw("https://example.com", html), "# test");

      const links = storage.getLinks("https://example.com");
      expect(links.length).toBeGreaterThanOrEqual(2);
      const urls = links.map((l) => l.url);
      expect(urls).toContain("https://example.com/about");
      expect(urls).toContain("https://example.com/docs");
    });

    it("should filter links with sameDomainOnly option", () => {
      const html = `<html><body>
        <p><a href="https://example.com/local">Local</a></p>
        <p><a href="https://other.com/external">External</a></p>
      </body></html>`;
      storage.store("https://example.com", makeRaw("https://example.com", html), "# test");

      const links = storage.getLinks("https://example.com", { sameDomainOnly: true });
      const urls = links.map((l) => l.url);
      expect(urls).toContain("https://example.com/local");
      expect(urls).not.toContain("https://other.com/external");
    });

    it("should return empty array for page with no links", () => {
      const html = `<html><body><h1>No links</h1></body></html>`;
      storage.store("https://example.com", makeRaw("https://example.com", html), "# test");

      const links = storage.getLinks("https://example.com");
      expect(links).toEqual([]);
    });
  });
});

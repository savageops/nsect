import { describe, it, expect } from "vitest";
import { extractWithCascade } from "../server/core/extractor.js";

/**
 * Build a fake Puppeteer Page that returns deterministic DOM content from a
 * single evaluate() call (mirrors the atomic DOM read pattern in the real
 * extractor). This lets us test the cascade tiers without launching a browser.
 */
function fakePage({
  html = "",
  url = "https://example.com/article",
  links = [],
  meta = {},
  schemaOrg = [],
  title = "Test Page",
  semanticText = null, // if set, tier-2 semantic extraction returns this text
} = {}) {
  return {
    url: () => url,
    async evaluate(fn, ...args) {
      const src = typeof fn === "function" ? fn.toString() : String(fn);
      // First call: the atomic DOM read (returns html/links/meta/schemaOrg).
      if (src.includes("pageHtml") || src.includes("linkList") || src.includes("jsonLd")) {
        return { html, links, meta, schemaOrg };
      }
      // Tier-2: semantic extraction (looks for article/main containers).
      if (src.includes("container") || src.includes("article")) {
        if (semanticText !== null) {
          return { text: semanticText, html, title };
        }
        return null; // no semantic container found
      }
      // Tier-3: legacy full-page fallback.
      if (src.includes("cloneNode") || src.includes("noiseSels")) {
        const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return { title, url, text, html };
      }
      return { html, links, meta, schemaOrg };
    },
    async content() {
      return html;
    },
  };
}

// ---------------------------------------------------------------------------
// extractWithCascade — the main extraction cascade
// ---------------------------------------------------------------------------

describe("extractWithCascade", () => {
  it("extracts links and meta from the atomic DOM read", async () => {
    const page = fakePage({
      html: "<html><body><p>Content</p></body></html>",
      links: [
        { text: "Link 1", href: "https://example.com/1" },
        { text: "Link 2", href: "https://example.com/2" },
      ],
      meta: { "og:title": "Test", description: "A test page" },
    });

    const result = await extractWithCascade(page, {});
    expect(result.links).toHaveLength(2);
    expect(result.links[0].href).toBe("https://example.com/1");
    expect(result.meta["og:title"]).toBe("Test");
  });

  it("captures JSON-LD schema.org structured data", async () => {
    const page = fakePage({
      html: "<html><body><p>Article content here that is long enough.</p></body></html>",
      schemaOrg: [
        {
          "@type": "Article",
          headline: "Test Article",
          author: { name: "Jane Doe" },
          datePublished: "2024-01-15",
        },
      ],
    });

    const result = await extractWithCascade(page, {});
    expect(result.schemaOrg).toHaveLength(1);
    expect(result.schemaOrg[0]["@type"]).toBe("Article");
    expect(result.author).toBe("Jane Doe");
    expect(result.published).toBe("2024-01-15");
  });

  it("extracts author from array-shaped author field", async () => {
    const page = fakePage({
      html: "<html><body><p>Content here.</p></body></html>",
      schemaOrg: [
        {
          "@type": "Article",
          author: [{ name: "John Smith" }],
          datePublished: "2025-06-01",
        },
      ],
    });

    const result = await extractWithCascade(page, {});
    expect(result.author).toBe("John Smith");
    expect(result.published).toBe("2025-06-01");
  });

  it("extracts author from string-shaped author field", async () => {
    const page = fakePage({
      html: "<html><body><p>Content here.</p></body></html>",
      schemaOrg: [
        {
          "@type": "NewsArticle",
          author: "Direct Author Name",
        },
      ],
    });

    const result = await extractWithCascade(page, {});
    expect(result.author).toBe("Direct Author Name");
  });

  it("handles empty schemaOrg gracefully", async () => {
    const page = fakePage({
      html: "<html><body><p>Real content that is long enough to pass the threshold check for substantive body text in the extraction cascade.</p></body></html>",
      schemaOrg: [],
    });

    const result = await extractWithCascade(page, {});
    expect(result.schemaOrg).toEqual([]);
    expect(result.author).toBeUndefined();
    expect(result.published).toBeUndefined();
  });

  it("returns a valid url from page.url()", async () => {
    const page = fakePage({
      url: "https://example.com/deep/path",
      html: `<html><head><title>Deep Path Page</title></head><body><article><p>${"Substantial content for URL test. ".repeat(15)}</p></article></body></html>`,
    });

    const result = await extractWithCascade(page, {});
    expect(result.url).toBe("https://example.com/deep/path");
  });

  it("includes markdown in the result when defuddle produces it", async () => {
    // defuddle processes the HTML string directly; give it real article HTML
    // so the DOM-scoring tier fires and produces markdown.
    const articleHtml = `<html><head><title>Real Article</title></head><body><article><h1>Hello World</h1><p>${"This is real article content. ".repeat(30)}</p></article><nav>Home About</nav></body></html>`;
    const page = fakePage({
      html: articleHtml,
      links: [],
      meta: {},
    });

    const result = await extractWithCascade(page, {});
    expect(result.text.length).toBeGreaterThan(50);
    expect(result.markdown).toBeDefined();
    // markdown should contain the heading
    expect(result.markdown).toContain("Hello World");
  });

  it("handles pages with no content gracefully (cascade falls through)", async () => {
    const page = fakePage({
      html: "<html><body></body></html>",
      links: [],
      meta: {},
    });

    const result = await extractWithCascade(page, {});
    // Should not throw — cascade should produce some (possibly empty) result
    expect(result).toBeDefined();
    expect(result.links).toEqual([]);
    expect(result.meta).toEqual({});
  });
});

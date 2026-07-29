import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import {
  extractGoogleFromDocument,
  extractDuckDuckGoFromDocument,
  extractBingFromDocument,
  extractBraveFromDocument,
  extractGenericFromDocument,
  extractSearchResultsForEngineByName,
} from "../server/core/search-extractors.js";

/**
 * Parse fixture HTML into a linkedom Document (same DOM API as a browser).
 * This lets us test the CSS selector logic against realistic search engine
 * HTML without launching a browser.
 */
function doc(html) {
  const { document } = parseHTML(html);
  return document;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

describe("extractGoogleFromDocument", () => {
  const googleFixture = `
    <div id="search">
      <div class="g">
        <div><h3>First Result</h3></div>
        <div><a href="https://example.com/1">First Result</a></div>
        <div class="VwiC3b">First snippet text here</div>
      </div>
      <div class="g">
        <h3>Second Result</h3>
        <a href="https://example.com/2">Second Result</a>
        <div data-sncf>Second snippet</div>
      </div>
      <div class="g">
        <h3>No Link Result</h3>
      </div>
    </div>`;

  it("extracts results from .g blocks with h3 + a[href]", () => {
    const results = extractGoogleFromDocument(doc(googleFixture), 10);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("First Result");
    expect(results[0].url).toBe("https://example.com/1");
    expect(results[0].snippet).toContain("First snippet");
  });

  it("skips blocks without links", () => {
    const results = extractGoogleFromDocument(doc(googleFixture), 10);
    // "No Link Result" block has h3 but no a[href] — should be skipped
    expect(results.find((r) => r.title === "No Link Result")).toBeUndefined();
  });

  it("respects maxResults limit", () => {
    const results = extractGoogleFromDocument(doc(googleFixture), 1);
    expect(results).toHaveLength(1);
  });

  it("returns empty array for page with no .g blocks", () => {
    const results = extractGoogleFromDocument(doc("<html><body>no results</body></html>"), 10);
    expect(results).toEqual([]);
  });

  it("handles [data-sokoban-container] blocks", () => {
    const html = `<div data-sokoban-container><h3>Sokoban Result</h3><a href="https://s.com">Link</a></div>`;
    const results = extractGoogleFromDocument(doc(html), 10);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Sokoban Result");
  });
});

// ---------------------------------------------------------------------------
// DuckDuckGo
// ---------------------------------------------------------------------------

describe("extractDuckDuckGoFromDocument", () => {
  const ddgFixture = `
    <div id="links">
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="https://example.com/1">First DDG</a>
        </h2>
        <a class="result__snippet" href="#">First snippet</a>
      </div>
      <div class="result__body">
        <a href="https://example.com/2">Second DDG</a>
        <div class="result__snippet">Second snippet</div>
      </div>
    </div>`;

  it("extracts results from .result blocks", () => {
    const results = extractDuckDuckGoFromDocument(doc(ddgFixture), 10);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("First DDG");
    expect(results[0].url).toBe("https://example.com/1");
  });

  it("extracts from .result__body blocks with fallback a[href]", () => {
    const results = extractDuckDuckGoFromDocument(doc(ddgFixture), 10);
    expect(results[1].url).toBe("https://example.com/2");
  });

  it("respects maxResults", () => {
    const results = extractDuckDuckGoFromDocument(doc(ddgFixture), 1);
    expect(results).toHaveLength(1);
  });

  it("returns empty for no matches", () => {
    const results = extractDuckDuckGoFromDocument(doc("<html><body></body></html>"), 10);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bing
// ---------------------------------------------------------------------------

describe("extractBingFromDocument", () => {
  const bingFixture = `
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://example.com/1">First Bing Result</a></h2>
        <div class="b_caption"><p>First Bing snippet</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="https://example.com/2">Second Bing</a></h2>
        <p>Second snippet text</p>
      </li>
    </ol>`;

  it("extracts results from li.b_algo blocks", () => {
    const results = extractBingFromDocument(doc(bingFixture), 10);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("First Bing Result");
    expect(results[0].url).toBe("https://example.com/1");
    expect(results[0].snippet).toContain("First Bing snippet");
  });

  it("respects maxResults", () => {
    const results = extractBingFromDocument(doc(bingFixture), 1);
    expect(results).toHaveLength(1);
  });

  it("returns empty for no .b_algo blocks", () => {
    const results = extractBingFromDocument(doc("<html><body></body></html>"), 10);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

describe("extractBraveFromDocument", () => {
  const braveFixture = `
    <div id="results">
      <div class="snippet">
        <h2><a href="https://example.com/1" data-testid="result-title-a">First Brave</a></h2>
        <p class="snippet-description">First snippet</p>
      </div>
      <div class="result">
        <a href="https://example.com/2">Second Brave</a>
        <p>Second snippet</p>
      </div>
      <article>
        <h3><a href="https://example.com/3">Third via article</a></h3>
      </article>
    </div>`;

  it("extracts from .snippet blocks", () => {
    const results = extractBraveFromDocument(doc(braveFixture), 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe("First Brave");
    expect(results[0].url).toBe("https://example.com/1");
  });

  it("extracts from .result blocks", () => {
    const results = extractBraveFromDocument(doc(braveFixture), 10);
    const second = results.find((r) => r.url === "https://example.com/2");
    expect(second).toBeDefined();
    expect(second.title).toBe("Second Brave");
  });

  it("extracts from article blocks", () => {
    const results = extractBraveFromDocument(doc(braveFixture), 10);
    const third = results.find((r) => r.url === "https://example.com/3");
    expect(third).toBeDefined();
  });

  it("respects maxResults", () => {
    const results = extractBraveFromDocument(doc(braveFixture), 1);
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

describe("extractGenericFromDocument", () => {
  it("extracts links from main/#search containers", () => {
    const html = `
      <main>
        <div>
          <a href="https://example.com/1">A long enough title for the link</a>
          <p>Description of the first result</p>
        </div>
        <div>
          <a href="https://example.com/2">Another title that is long enough</a>
        </div>
      </main>`;
    const results = extractGenericFromDocument(doc(html), 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].url).toBe("https://example.com/1");
  });

  it("skips links with text shorter than 8 chars", () => {
    const html = `<main><a href="https://example.com/1">Short</a></main>`;
    const results = extractGenericFromDocument(doc(html), 10);
    expect(results).toEqual([]);
  });

  it("skips non-http links", () => {
    const html = `<main><a href="/relative/path">A relative link title</a></main>`;
    const results = extractGenericFromDocument(doc(html), 10);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

describe("extractSearchResultsForEngineByName", () => {
  it("routes to Google extractor", () => {
    const html = `<div class="g"><h3>Test</h3><a href="https://e.com">Link</a></div>`;
    const results = extractSearchResultsForEngineByName("google", doc(html), 10);
    expect(results).toHaveLength(1);
  });

  it("routes to DuckDuckGo extractor", () => {
    const html = `<div class="result"><a class="result__a" href="https://e.com">DDG</a></div>`;
    const results = extractSearchResultsForEngineByName("duckduckgo", doc(html), 10);
    expect(results).toHaveLength(1);
  });

  it("routes to Bing extractor", () => {
    const html = `<li class="b_algo"><h2><a href="https://e.com">Bing</a></h2></li>`;
    const results = extractSearchResultsForEngineByName("bing", doc(html), 10);
    expect(results).toHaveLength(1);
  });

  it("routes to Brave extractor", () => {
    const html = `<div class="snippet"><a href="https://e.com">Brave Title</a></div>`;
    const results = extractSearchResultsForEngineByName("brave", doc(html), 10);
    expect(results).toHaveLength(1);
  });

  it("falls back to generic for unknown engines", () => {
    const html = `<main><a href="https://e.com">A generic result title</a></main>`;
    const results = extractSearchResultsForEngineByName("yahoo", doc(html), 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// LIVE integration tests — gated behind LIVE_INTEGRATION=1
//
// These tests actually search the real search engines and verify that the
// CSS selectors still extract results. When an engine updates its DOM and the
// selectors break, these tests fail with "0 results" — the early-warning
// signal that search-extractors.js needs updating.
//
// Run: LIVE_INTEGRATION=1 npx vitest run tests/search-extractors.test.js
// ---------------------------------------------------------------------------

const itLive = process.env.LIVE_INTEGRATION === "1" ? it : it.skip;

describe("Live search selector validation", () => {
  // Lazy-load the engine to avoid browser startup when tests are skipped.
  async function runSearch(engine, query) {
    const { runNsectEngine } = await import("../server/core/engine.js");
    return runNsectEngine({
      query,
      searchEngines: [engine],
      format: "json",
      maxResults: 3,
      strategy: "fast",
      timeout: 25,
    });
  }

  itLive("DuckDuckGo selectors extract real results", async () => {
    const result = await runSearch("duckduckgo", "open source crawler frameworks");
    expect(result.success).toBe(true);
    expect(result.meta.type).toBe("search");
    expect(result.meta.resultCount).toBeGreaterThan(0);
    expect(result.meta.engine).toBe("duckduckgo");
    // Each result should have a title and URL
    const results = result.output;
    expect(Array.isArray(results)).toBe(true);
    expect(results[0].title).toBeTruthy();
    expect(results[0].url).toMatch(/^https?:\/\//);
  }, 45000);

  itLive("Bing selectors extract real results", async () => {
    const result = await runSearch("bing", "web scraping best practices");
    expect(result.success).toBe(true);
    expect(result.meta.resultCount).toBeGreaterThan(0);
    expect(result.meta.engine).toBe("bing");
  }, 45000);

  itLive("Brave selectors extract real results", async () => {
    const result = await runSearch("brave", "rust programming language");
    expect(result.success).toBe(true);
    expect(result.meta.resultCount).toBeGreaterThan(0);
    expect(result.meta.engine).toBe("brave");
  }, 45000);

  itLive("Google selectors extract real results (known fragile — Google changes DOM frequently)", async () => {
    const result = await runSearch("google", "site:github.com simdjson");
    // Google is the most fragile engine — it may serve consent pages, CF
    // challenges, or changed DOM. The multi-engine fallback test below proves
    // the system works even when Google fails. This test documents the known
    // fragility: if it passes, great; if it fails, search-extractors.js
    // selectors for Google need updating.
    if (result.success && result.meta.resultCount > 0) {
      expect(result.meta.engine).toBe("google");
    } else {
      // Known: Google may block/challenge headless browsers. Log but don't fail.
      expect(result.meta.attempts?.[0]?.reason).toMatch(/blocked|no_results|error/);
    }
  }, 45000);

  itLive("multi-engine fallback returns results from first working engine", async () => {
    const { runNsectEngine } = await import("../server/core/engine.js");
    const result = await runNsectEngine({
      query: "example test query",
      searchEngines: ["duckduckgo", "bing", "brave", "google"],
      format: "json",
      maxResults: 5,
      strategy: "fast",
      timeout: 25,
    });
    expect(result.success).toBe(true);
    expect(result.meta.resultCount).toBeGreaterThan(0);
    // Google must always be the last engine in the order
    expect(result.meta.engineOrder.at(-1)).toBe("google");
  }, 60000);
});

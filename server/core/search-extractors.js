/**
 * Search result extraction logic — decoupled from Puppeteer so it can be
 * unit-tested with fixture HTML (via linkedom/jsdom).
 *
 * Each extractor takes a Document (or any object implementing querySelector/
 * querySelectorAll) and a max result count, and returns an array of
 * { title, url, snippet } objects.
 *
 * The engine wraps these in page.evaluate() to run them against the live
 * browser DOM. The selectors are deliberately broad (multiple fallbacks per
 * engine) because search engines change their DOM structure frequently.
 *
 * BRITTLE SELECTOR NOTE: these WILL break when engines update their markup.
 * The multi-engine fallback + generic extractor mitigate this in practice,
 * but the selectors should be updated when live testing shows breakage.
 */

/**
 * Extract Google search results from a document.
 * Selectors: [data-sokoban-container], .g, [class*="kp-blk"] blocks.
 * Title: h3; Link: a[href]; Snippet: [data-sncf], .VwiC3b, span[style].
 */
export function extractGoogleFromDocument(doc, maxResults) {
  const results = [];
  const blocks = doc.querySelectorAll(
    '[data-sokoban-container], .g, [class*="kp-blk"]',
  );

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const titleEl = block.querySelector("h3");
    const linkEl = block.querySelector("a[href]");
    const snippetEl = block.querySelector(
      '[data-sncf], [style*="-webkit-line-clamp"], .VwiC3b, span[style]',
    );
    if (!titleEl || !linkEl?.href || !linkEl?.getAttribute("href")) continue;

    results.push({
      title: (titleEl.textContent || "").trim(),
      url: linkEl.href,
      snippet: snippetEl ? (snippetEl.textContent || "").trim() : "",
    });
  }
  return results;
}

/**
 * Extract DuckDuckGo (html.duckduckgo.com) search results.
 * Selectors: .result, .result__body blocks.
 * Link: a.result__a, .result__title a[href]; Snippet: .result__snippet.
 */
export function extractDuckDuckGoFromDocument(doc, maxResults) {
  const results = [];
  const blocks = doc.querySelectorAll(".result, .result__body");

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const linkEl = block.querySelector("a.result__a, .result__title a[href], a[href]");
    if (!linkEl?.href || !linkEl?.getAttribute("href")) continue;
    const snippetEl = block.querySelector(".result__snippet, .result__extras");

    results.push({
      title: (linkEl.textContent || "").trim(),
      url: linkEl.href,
      snippet: snippetEl ? (snippetEl.textContent || "").trim() : "",
    });
  }
  return results;
}

/**
 * Extract Bing search results.
 * Selectors: li.b_algo blocks.
 * Link: h2 a[href]; Snippet: .b_caption p, .b_snippet.
 */
export function extractBingFromDocument(doc, maxResults) {
  const results = [];
  const blocks = doc.querySelectorAll("li.b_algo, .b_algo");

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const linkEl = block.querySelector("h2 a[href], a[href]");
    if (!linkEl?.href || !linkEl?.getAttribute("href")) continue;
    const snippetEl = block.querySelector(".b_caption p, .b_snippet, p");

    results.push({
      title: (linkEl.textContent || "").trim(),
      url: linkEl.href,
      snippet: snippetEl ? (snippetEl.textContent || "").trim() : "",
    });
  }
  return results;
}

/**
 * Extract Brave Search results.
 * Selectors: .snippet, .result, .fdb, article blocks.
 * Link: h2 a[href], h3 a[href], a[data-testid='result-title-a']; Snippet: p.
 */
export function extractBraveFromDocument(doc, maxResults) {
  const results = [];
  const blocks = doc.querySelectorAll(".snippet, .result, .fdb, article");

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const linkEl = block.querySelector(
      "h2 a[href], h3 a[href], a[data-testid='result-title-a'], a[href]",
    );
    if (!linkEl?.href || !linkEl?.getAttribute("href")) continue;
    const snippetEl = block.querySelector("p, .snippet-description, .snippet-content");

    results.push({
      title: (linkEl.textContent || "").trim(),
      url: linkEl.href,
      snippet: snippetEl ? (snippetEl.textContent || "").trim() : "",
    });
  }
  return results;
}

/**
 * Generic fallback extractor — works on any search page with main/#search/
 * [role='main'] containers. Used when engine-specific selectors fail.
 */
export function extractGenericFromDocument(doc, maxResults) {
  const results = [];
  const anchors = doc.querySelectorAll(
    "main a[href], #search a[href], [role='main'] a[href]",
  );

  for (const anchor of anchors) {
    if (results.length >= maxResults) break;
    const href = anchor.href || anchor.getAttribute("href");
    if (!href || !href.startsWith("http")) continue;
    const text = (anchor.textContent || "").trim();
    if (text.length < 8) continue;

    const container = anchor.closest("article, li, div, section") || anchor.parentElement;
    const snippetEl = container?.querySelector("p");
    const snippet = snippetEl ? (snippetEl.textContent || "").trim() : "";

    results.push({ title: text, url: href, snippet });
  }
  return results;
}

/**
 * Dispatcher: route to the engine-specific extractor by name.
 */
export function extractSearchResultsForEngineByName(engine, doc, maxResults) {
  switch (engine) {
    case "duckduckgo":
      return extractDuckDuckGoFromDocument(doc, maxResults);
    case "bing":
      return extractBingFromDocument(doc, maxResults);
    case "brave":
      return extractBraveFromDocument(doc, maxResults);
    case "google":
      return extractGoogleFromDocument(doc, maxResults);
    default:
      return extractGenericFromDocument(doc, maxResults);
  }
}

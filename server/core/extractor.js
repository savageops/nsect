/**
 * Content extraction layer — replaces the naive innerText + noise-selector-strip
 * approach with DOM-scoring extraction (defuddle) plus a fallback cascade.
 *
 * Defuddle scores page elements by text density and structure to identify the
 * main content vs chrome/nav/ads/boilerplate — the same approach Mozilla
 * Readability uses, extended with JSON-LD capture, mobile-CSS-aware pruning,
 * and clean markdown output. For pages where defuddle returns near-empty
 * (non-article pages, SPAs that didn't fully render), we fall back to:
 *   1. <article>/<main>/[role=main] extraction
 *   2. The legacy noise-selector strip + innerText
 *
 * The cascade design is borrowed from trafilatura (the strongest open-source
 * extractor per independent benchmarks) — high-precision first, fall back to
 * density-based, fall back to raw.
 */

import { Defuddle } from "defuddle/node";
import { logEvent } from "../observability/logging.js";

/**
 * Extract main content + structured data from a rendered page.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ verbose?: boolean, noiseSelectors?: string[] }} [options]
 * @returns {Promise<{ title: string, url: string, text: string, html: string, markdown: string, links: Array<{text:string,href:string}>, meta: Record<string,string>, schemaOrg: Array<object>, author?: string, published?: string }>}
 */
export async function extractWithCascade(page, options = {}) {
  const { verbose = false, noiseSelectors = [] } = options;

  // Grab EVERYTHING from the DOM in a single atomic evaluate() call. This
  // eliminates the TOCTOU race where separate page.content() + page.evaluate()
  // calls could see different DOM states on a fast-updating SPA. One round-trip
  // also reduces IPC overhead vs 4 separate evaluate calls.
  const { html, links, meta, schemaOrg } = await page.evaluate(() => {
    const pageHtml = document.documentElement.outerHTML;

    const linkList = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({
        text: (a.textContent || "").trim().substring(0, 200),
        href: a.href,
      }))
      .filter((l) => l.href && l.href.startsWith("http"));

    const metaMap = {};
    document.querySelectorAll("meta[property], meta[name]").forEach((m) => {
      const key = m.getAttribute("property") || m.getAttribute("name");
      const val = m.getAttribute("content");
      if (key && val) metaMap[key] = val;
    });

    // JSON-LD (schema.org structured data) — ~90% of sites use it.
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => {
        try { return JSON.parse(s.textContent); } catch { return null; }
      })
      .filter(Boolean);

    return { html: pageHtml, links: linkList, meta: metaMap, schemaOrg: jsonLd };
  });

  const url = page.url();

  // Tier 1: defuddle (DOM-scoring main-content extraction).
  try {
    const result = await Defuddle(html, url, { content: "markdown" });
    const text = htmlToText(result.content || "");
    const markdown = result.contentMarkdown || htmlToMarkdownFallback(result.content || "");

    // Defuddle succeeded if it found substantive content.
    if (text.trim().length > 50) {
      return {
        title: result.title || "",
        url,
        text,
        html: verbose ? html : (result.content || html),
        markdown: markdown || text,
        links,
        meta: { ...meta, ...(result.metaTags || {}) },
        schemaOrg: schemaOrg.length ? schemaOrg : (result.schemaOrgData || []),
        author: result.author || extractFromSchemaOrg(schemaOrg, "author"),
        published: result.published || extractFromSchemaOrg(schemaOrg, "datePublished"),
      };
    }
  } catch (defuddleErr) {
    // defuddle failed — log so operators can monitor extraction-quality
    // regressions. Falling through to the cascade is correct behavior, but a
    // silent failure here would hide a systemic defuddle issue.
    logEvent("extractor.defuddle_failed", {
      url,
      error: defuddleErr.message?.substring(0, 200),
    });
  }

  // Tier 2: semantic <article>/<main>/[role=main] extraction.
  const semantic = await page.evaluate((isVerbose, noiseSels) => {
    const container = document.querySelector("article, main, [role='main'], #content, .content, .post, .article");
    if (!container) return null;
    const clone = container.cloneNode(true);
    if (!isVerbose) {
      for (const sel of noiseSels) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }
    const text = (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    return { text, html: clone.innerHTML, title: document.title };
  }, verbose, noiseSelectors).catch(() => null);

  if (semantic && semantic.text.trim().length > 50) {
    return {
      title: semantic.title || "",
      url,
      text: semantic.text,
      html: semantic.html,
      markdown: htmlToMarkdownFallback(semantic.html),
      links,
      meta,
      schemaOrg,
      author: extractFromSchemaOrg(schemaOrg, "author"),
      published: extractFromSchemaOrg(schemaOrg, "datePublished"),
    };
  }

  // Tier 3: legacy full-page noise-selector strip + innerText (the old default).
  const fallback = await page.evaluate((isVerbose, noiseSels) => {
    const clone = document.cloneNode(true);
    if (!isVerbose) {
      for (const sel of noiseSels) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }
    const body = clone.body || clone.documentElement;
    const text = (body.innerText || body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    const pageHtml = clone.documentElement.outerHTML;
    return { title: document.title, url: window.location.href, text, html: pageHtml };
  }, verbose, noiseSelectors);

  return {
    ...fallback,
    markdown: htmlToMarkdownFallback(fallback.html),
    links,
    meta,
    schemaOrg,
    author: extractFromSchemaOrg(schemaOrg, "author"),
    published: extractFromSchemaOrg(schemaOrg, "datePublished"),
  };
}

/**
 * Strip HTML tags to plain text (best-effort when defuddle's markdown is empty).
 */
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Minimal HTML→markdown fallback (used only when defuddle's markdown output
 * is empty). The real conversion is defuddle's; this is a last resort.
 */
function htmlToMarkdownFallback(html) {
  let md = html;
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gis, "$1\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  md = md.replace(/<[^>]+>/g, "");
  md = md.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  return md;
}

/**
 * Pull a field (author, datePublished) from the first matching JSON-LD object.
 */
function extractFromSchemaOrg(schemaOrg, field) {
  for (const entry of schemaOrg) {
    if (!entry || typeof entry !== "object") continue;
    // Handle both {author: {name: "x"}} and {author: "x"} shapes.
    const val = entry[field];
    if (typeof val === "string") return val;
    if (val && typeof val === "object" && val.name) return val.name;
    if (Array.isArray(val) && val[0]?.name) return val[0].name;
  }
  return undefined;
}

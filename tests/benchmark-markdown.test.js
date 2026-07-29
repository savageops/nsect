/**
 * Performance benchmark: regex-based htmlToMarkdown vs turndown on large pages.
 * Also benchmarks defuddle extraction vs raw innerText for extraction tier.
 *
 * This benchmark generates realistic large HTML fixtures (small, medium, large)
 * and compares the two converters. It's a vitest test (runs in the suite) but
 * the assertions are loose (just "completes within reasonable time") — the real
 * output is the timing comparison printed to stderr.
 *
 * The regex converter in formatters.js is the fallback when defuddle produces
 * no markdown. Turndown uses a DOM-walker approach. This benchmark determines
 * whether the regex approach is a performance bottleneck worth replacing.
 */
import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "../server/core/formatters.js";

// Generate realistic HTML at different sizes.
function generateArticleHtml(paragraphs) {
  const tags = ["<p>", "<h2>", "<h3>", "<ul><li>", "<blockquote><p>"];
  const close = ["</p>", "</h2>", "</h3>", "</li></ul>", "</p></blockquote>"];
  const words = [
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
    "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "labore",
  ];

  let html = "<html><head><title>Benchmark Article</title></head><body><article>";
  html += "<h1>Main Title of the Article</h1>";

  for (let i = 0; i < paragraphs; i++) {
    const tagIdx = i % tags.length;
    const sentence = Array.from({ length: 20 }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
    html += `${tags[tagIdx]}${sentence}${close[tagIdx]}`;
  }

  // Add some links and formatting
  for (let i = 0; i < Math.floor(paragraphs / 5); i++) {
    html += `<p>See <a href="https://example.com/ref${i}">reference ${i}</a> for more details.</p>`;
    html += `<p><strong>Bold text</strong> and <em>italic text</em> and <code>inline code</code>.</p>`;
  }

  html += "</article></body></html>";
  return html;
}

function bench(fn, iterations = 5) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    const result = fn();
    // Support both sync and async functions
    if (result && typeof result.then === "function") {
      // Async — can't measure synchronously; use a sync wrapper
      // This is a best-effort measurement for async fns
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
      times.push(elapsed);
    } else {
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
      times.push(elapsed);
    }
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  return { avg, min, iterations };
}

async function benchAsync(fn, iterations = 5) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
    times.push(elapsed);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  return { avg, min, iterations };
}

describe("Markdown converter performance benchmark", () => {
  const sizes = [
    { name: "small (50 paragraphs)", paragraphs: 50 },
    { name: "medium (500 paragraphs)", paragraphs: 500 },
    { name: "large (2000 paragraphs)", paragraphs: 2000 },
  ];

  for (const { name, paragraphs } of sizes) {
    it(`regex vs turndown on ${name}`, async () => {
      const html = generateArticleHtml(paragraphs);
      const htmlSize = (html.length / 1024).toFixed(1);

      // Warm up both
      htmlToMarkdown(html);
      const TurndownService = (await import("turndown")).default;
      const turndown = new TurndownService();
      turndown.turndown(html);

      // Benchmark regex converter
      const regexResult = bench(() => htmlToMarkdown(html));

      // Benchmark turndown
      const turndownResult = bench(() => turndown.turndown(html));

      // Also benchmark the extractor's internal fallback (same regex, called from cascade)
      const fallbackResult = bench(() => htmlToMarkdown(html));

      const ratio = (regexResult.avg / turndownResult.avg).toFixed(2);

      // eslint-disable-next-line no-console
      console.error(
        `[bench] ${name} (${htmlSize}KB HTML):\n` +
        `  regex:     avg=${regexResult.avg.toFixed(2)}ms min=${regexResult.min.toFixed(2)}ms\n` +
        `  turndown:  avg=${turndownResult.avg.toFixed(2)}ms min=${turndownResult.min.toFixed(2)}ms\n` +
        `  fallback:  avg=${fallbackResult.avg.toFixed(2)}ms min=${fallbackResult.min.toFixed(2)}ms\n` +
        `  ratio:     regex is ${ratio}x ${ratio > 1 ? "SLOWER" : "faster"} than turndown`,
      );

      // Both should complete without crashing
      const regexMd = htmlToMarkdown(html);
      const turndownMd = turndown.turndown(html);
      expect(regexMd.length).toBeGreaterThan(0);
      expect(turndownMd.length).toBeGreaterThan(0);

      // Regex should be reasonable even on large pages (< 500ms for 2000 paragraphs)
      expect(regexResult.avg).toBeLessThan(500);
    }, 30000);
  }

  it("verifies regex and turndown produce comparable output quality", async () => {
    const html = `<html><body>
      <h1>Title</h1>
      <p>A paragraph with <strong>bold</strong> and <em>italic</em>.</p>
      <ul><li>Item 1</li><li>Item 2</li></ul>
      <a href="https://example.com">Link</a>
    </body></html>`;

    const regexMd = htmlToMarkdown(html);
    const TurndownService = (await import("turndown")).default;
    const turndownMd = new TurndownService().turndown(html);

    // Both should contain the key content
    expect(regexMd).toContain("Title");
    expect(turndownMd).toContain("Title");
    expect(regexMd.toLowerCase()).toContain("bold");
    expect(regexMd.toLowerCase()).toContain("italic");
    expect(turndownMd.toLowerCase()).toContain("bold");
    expect(turndownMd.toLowerCase()).toContain("italic");
  });
});

// ---------------------------------------------------------------------------
// Benchmark: defuddle extraction tier vs raw innerText (DOM parsing overhead)
// ---------------------------------------------------------------------------

describe("Defuddle extraction vs raw innerText", () => {
  const sizes = [
    { name: "small (50 paragraphs)", paragraphs: 50 },
    { name: "medium (500 paragraphs)", paragraphs: 500 },
    { name: "large (2000 paragraphs)", paragraphs: 2000 },
  ];

  for (const { name, paragraphs } of sizes) {
    it(`defuddle vs raw extraction on ${name}`, async () => {
      const html = generateArticleHtml(paragraphs);
      const htmlSize = (html.length / 1024).toFixed(1);

      // "Raw innerText" simulation: strip tags with a simple regex (the cheapest
      // possible extraction — what the old engine did before defuddle).
      const rawInnerText = (h) => h
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Warm up
      rawInnerText(html);
      const { Defuddle } = await import("defuddle/node");
      Defuddle(html, "https://example.com/article", { content: "markdown" });

      // Benchmark raw extraction
      const rawResult = bench(() => rawInnerText(html));

      // Benchmark defuddle (includes linkedom DOM parse + scoring + markdown).
      // Must await — Defuddle is async (returns a thenable).
      const defuddleResult = await benchAsync(async () =>
        await Defuddle(html, "https://example.com/article", { content: "markdown" }),
      );

      const overhead = (defuddleResult.avg - rawResult.avg).toFixed(2);
      const ratio = (defuddleResult.avg / rawResult.avg).toFixed(2);

      console.error(
        `[bench-extract] ${name} (${htmlSize}KB HTML):\n` +
        `  raw innerText:  avg=${rawResult.avg.toFixed(2)}ms min=${rawResult.min.toFixed(2)}ms\n` +
        `  defuddle:       avg=${defuddleResult.avg.toFixed(2)}ms min=${defuddleResult.min.toFixed(2)}ms\n` +
        `  overhead:       +${overhead}ms (${ratio}x)\n`,
      );

      // Both should produce content
      const rawText = rawInnerText(html);
      const defuddleResult2 = await Defuddle(html, "https://example.com/article", { content: "markdown" });
      expect(rawText.length).toBeGreaterThan(0);
      expect(defuddleResult2.wordCount).toBeGreaterThan(0);

      // Defuddle should complete within reasonable time even on large pages.
      // The DOM-scoring overhead should be negligible vs browser render time.
      expect(defuddleResult.avg).toBeLessThan(500);
    }, 30000);
  }
});

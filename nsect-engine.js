#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FORMATS, METHODS } from "./server/core/fingerprint.js";
import {
  DEFAULT_SEARCH_ENGINES,
  SUPPORTED_SEARCH_ENGINES,
} from "./server/core/search.js";
import {
  RequestValidationError,
  normalizeEngineRequest,
} from "./server/core/request.js";
import { runNsectEngine } from "./server/core/engine.js";

function printHelp() {
  const formatHelp = FORMATS.map((format) => `  ${format}`).join("\n");
  const searchHelp = SUPPORTED_SEARCH_ENGINES.map((engine) => `  ${engine}`).join("\n");

  console.log(`
nsect v1.0.0

USAGE:
  node nsect-engine.js --url <url> [options]
  node nsect-engine.js --query <query> [options]

REQUIRED (one of):
  --url <url>            Target URL to extract
  --query <query>        Search query to run across fallback engines
  --google <query>       Legacy alias for --query

STRATEGY:
  --strategy <s>         Extraction strategy (default: auto)
    auto                 Detect challenges + SPA + infinite scroll automatically
    fast                 Static pages, minimum wait
    patient              Slow renders; pair with --selector or --render-wait
    spa                  Client-rendered single-page apps
    scroll               Infinite feeds
  --method <method>      Legacy alias for --strategy (direct/wait/timed/spa/scroll)
  --bypass-challenges    Enable challenge detection/resolution for non-auto strategies
  --challenge-timeout <s>  Budget for auto-resolvable challenges (default: 15)
  --render-wait <s>      Extra seconds to wait for slow renders (default: 0)

OPTIONS:
  --format <format>      Output format (default: text)
                         text/html/markdown -> string; json/links -> structured
  --verbose              Include all content (default: filtered)
  --selector <css>       CSS selector for strategy=patient
  --timeout <sec>        Overall operation timeout in seconds (default: 30)
  --scroll-count <n>     Scroll iterations for strategy=scroll (default: 20)
  --scroll-delay <ms>    Delay between scrolls in milliseconds (default: 800)
  --delay <ms>           Pre-engine randomized delay floor in ms (default: 1000)
  --max-results <n>      Maximum search results to return (default: 10)
  --google-count <n>     Legacy alias for --max-results
  --search-engines <csv> Search fallback order; Google is always forced last
                         (default: ${DEFAULT_SEARCH_ENGINES.join(",")})
  --proxy <url>          HTTP/HTTPS proxy URL
  --cookies <json>       Cookies JSON array
  --headers <json>       Extra headers JSON object
  --headless             Run browser headless (default)
  --no-headless          Run with visible browser for debugging
  --screenshot <path>    Save full-page screenshot to file
  --pdf <path>           Save page as PDF
  --list-links           Print discovered links to stderr
  --metadata             Print engine metadata to stderr
  --output <path>        Write output to file instead of stdout
  --help                 Show this help

FORMATS:
${formatHelp}

SEARCH ENGINES:
${searchHelp}
`);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      query: { type: "string" },
      google: { type: "string" },
      strategy: { type: "string" },
      method: { type: "string" },
      format: { type: "string", default: "text" },
      verbose: { type: "boolean", default: false },
      selector: { type: "string" },
      timeout: { type: "string", default: "30" },
      "render-wait": { type: "string", default: "0" },
      "challenge-timeout": { type: "string", default: "15" },
      "bypass-challenges": { type: "boolean", default: false },
      "scroll-count": { type: "string", default: "20" },
      "scroll-delay": { type: "string", default: "800" },
      delay: { type: "string", default: "1000" },
      "max-results": { type: "string" },
      "google-count": { type: "string", default: "10" },
      "search-engines": { type: "string" },
      proxy: { type: "string" },
      cookies: { type: "string" },
      headers: { type: "string" },
      headless: { type: "boolean", default: true },
      "no-headless": { type: "boolean", default: false },
      screenshot: { type: "string" },
      pdf: { type: "string" },
      "list-links": { type: "boolean", default: false },
      metadata: { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return values;
}

function writeOutput(pathValue, content) {
  const outputPath = resolve(pathValue);
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, content, "utf-8");
  return outputPath;
}

function printMetadata(result, params) {
  const { meta } = result;
  if (!meta) return;
  console.error("[meta] Strategy:", meta.strategy || params.strategy || "auto");
  console.error("[meta] Format:", params.format);
  if (params.url) console.error("[meta] Target:", params.url);
  if (params.query) console.error("[meta] Search query:", params.query);
  console.error("[meta] Elapsed:", `${meta.elapsed}s`);
  if (meta.challenge?.detected) {
    const status = meta.challenge.resolved ? "resolved" : "BLOCKED";
    console.error(`[meta] Challenge: ${meta.challenge.label} (${status}, ${meta.challenge.waitedMs}ms)`);
  }
  if (meta.type === "page") {
    console.error("[meta] Title:", meta.title || "(unknown)");
    console.error("[meta] URL:", meta.url || "(unknown)");
    console.error("[meta] Text length:", meta.textLength ?? 0);
    console.error("[meta] Links found:", meta.linksFound ?? 0);
  }
  if (meta.type === "search") {
    console.error("[meta] Search engine:", meta.engine || "(none)");
    console.error("[meta] Search results:", meta.resultCount ?? 0);
    if (Array.isArray(meta.attempts)) {
      for (const attempt of meta.attempts) {
        const attemptStatus = attempt.reason || (attempt.resultCount > 0 ? "ok" : "no_results");
        console.error(
          `[meta] Attempt: ${attempt.engine} => ${attemptStatus} (${attempt.resultCount ?? 0})`,
        );
      }
    }
  }
  if (meta.fingerprint) {
    console.error("[meta] Fingerprint:", `${meta.fingerprint.userAgent?.substring(0, 60)}...`);
    console.error(
      "[meta] Viewport:",
      `${meta.fingerprint.viewport?.width}x${meta.fingerprint.viewport?.height}`,
    );
    console.error("[meta] Locale:", meta.fingerprint.locale);
    console.error("[meta] Timezone:", meta.fingerprint.timezone);
  }
  if (meta.artifacts?.screenshotPath) {
    console.error("[meta] Screenshot:", meta.artifacts.screenshotPath);
  }
  if (meta.artifacts?.pdfPath) {
    console.error("[meta] PDF:", meta.artifacts.pdfPath);
  }
}

function printLinks(result) {
  const links = result.meta?.links;
  if (!Array.isArray(links) || links.length === 0) {
    console.error("[links] No links found.");
    return;
  }
  console.error(`[links] Found ${links.length} links:`);
  for (const link of links) {
    const text = (link.text || "").trim();
    console.error(`  ${link.href}${text ? ` | ${text}` : ""}`);
  }
}

async function main() {
  const opts = parseCli();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let params;
  try {
    params = normalizeEngineRequest(
      {
        ...opts,
        renderWait: opts["render-wait"],
        challengeTimeout: opts["challenge-timeout"],
        bypassChallenges: opts["bypass-challenges"],
        scrollCount: opts["scroll-count"],
        scrollDelay: opts["scroll-delay"],
        maxResults: opts["max-results"],
        googleCount: opts["google-count"],
        searchEngines: opts["search-engines"],
        listLinks: opts["list-links"],
        screenshotPath: opts.screenshot,
        pdfPath: opts.pdf,
      },
      { allowFileOutput: true, allowHeadful: true },
    );
  } catch (err) {
    if (err instanceof RequestValidationError) {
      console.error(`[error] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const result = await runNsectEngine(params);
  if (!result.success) {
    console.error(`[error] ${result.error}`);
    process.exit(1);
  }

  if (opts.metadata) {
    printMetadata(result, params);
  }
  if (params.listLinks && result.meta?.type === "page") {
    printLinks(result);
  }

  const output = typeof result.output === "string"
    ? result.output
    : JSON.stringify(result.output, null, 2);

  if (opts.output) {
    const savedPath = writeOutput(opts.output, output);
    if (opts.metadata) {
      console.error("[meta] Output saved:", savedPath);
    }
    return;
  }

  console.log(output);
}

main().catch((err) => {
  console.error("[error]", err.message);
  process.exit(1);
});

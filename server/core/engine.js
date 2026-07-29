import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import rebrowserPuppeteerCore from "rebrowser-puppeteer-core";
import { existsSync } from "node:fs";
import {
  generateFingerprint,
  NOISE_SELECTORS,
  randomInt,
} from "./fingerprint.js";
import { formatOutput, formatGoogleResults } from "./formatters.js";
import { normalizeEngineRequest } from "./request.js";
import {
  buildSearchUrl,
  decodeSearchResultUrl,
  isSearchBlocked,
  searchEngineLabel,
} from "./search.js";
import {
  detectChallenge,
  waitForChallengeResolution,
  hasSubstantiveContent,
  detectInfiniteScroll,
} from "./challenge.js";
import { extractWithCascade } from "./extractor.js";
import { attemptSolve, isSolverEligible } from "./solver.js";
import { logEvent } from "../observability/logging.js";

// Use the rebrowser-patched puppeteer-core instead of stock puppeteer-core.
// rebrowser-patches fixes the Runtime.enable CDP leak — the #1 DataDome
// detection vector — plus the sourceURL and __puppeteer_utility_world__ leaks
// that puppeteer-stealth cannot reach (they're protocol-level, not JS-level).
// puppeteer-extra's addExtra() swaps the underlying puppeteer instance.
puppeteer.addExtra(rebrowserPuppeteerCore);
puppeteer.use(StealthPlugin());

/**
 * Detect a real stable-channel Chrome install. The bundled Chrome-for-Testing
 * has a TLS JA3 fingerprint that matches no real Chrome release — a detection
 * vector against TLS-fingerprinting anti-bots. Preferring a real stable Chrome
 * (Program Files / Applications / usr/bin) makes the fingerprint match at least
 * one genuine Chrome release. Falls back to the bundled Chromium when no real
 * Chrome is found.
 */
function detectRealChromePath() {
  const candidates = [
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch { /* ignore */ }
  }
  return null;
}

async function buildBrowser(opts, fp) {
  const args = [
    `--window-size=${fp.viewport.width},${fp.viewport.height}`,
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--lang=" + fp.locale,
    // Ignore certificate errors at the Chrome process level. The Puppeteer
    // `ignoreHTTPSErrors` option alone is insufficient — Chrome still rejects
    // bad certs at navigation time with ERR_CERT_AUTHORITY_INVALID. This flag
    // makes fork mirrors (library.lol, lgli.in) and self-signed dev endpoints
    // reachable. Mirrored in the Rust engine's LaunchOptions.
    "--ignore-certificate-errors",
  ];

  if (opts.proxy) {
    // Strip credentials from the proxy URL passed to Chrome — the
    // --proxy-server flag cannot carry auth. Credentials are applied via
    // page.authenticate() in setPageContext (the canonical Puppeteer method).
    const proxyUrl = opts.proxy.replace(/:\/\/[^@]*@/, "://");
    args.push(`--proxy-server=${proxyUrl}`);
  }

  const launchOpts = {
    headless: opts.headless,
    args,
    defaultViewport: fp.viewport,
    ignoreHTTPSErrors: true,
    protocolTimeout: (opts.timeout || 30) * 1000 + 15000,
  };

  // Prefer a real stable Chrome for a genuine TLS fingerprint, unless the
  // operator forces the bundled Chromium via NSECT_USE_BUNDLED_CHROME=1.
  if (process.env.NSECT_USE_BUNDLED_CHROME !== "1") {
    const realChrome = detectRealChromePath();
    if (realChrome) launchOpts.executablePath = realChrome;
  }

  return puppeteer.launch(launchOpts);
}

async function injectFingerprint(page, fp) {
  // Set timezone at the V8 engine level via CDP — this is the proper way to
  // spoof timezone. The old prototype hack (Date.prototype.getTimezoneOffset)
  // only affected getTimezoneOffset() and left Intl.DateTimeFormat reporting
  // the real timezone, an inconsistency anti-bots specifically probe. The CDP
  // Emulation.setTimezoneOverride handles DST correctly and covers all Date
  // and Intl APIs uniformly.
  try {
    await page.emulateTimezone(fp.timezone);
  } catch (tzErr) {
    // Some Chromium builds reject certain timezone strings. Log so operators
    // can detect when timezone spoofing isn't working — the fingerprint
    // metadata will claim a timezone the browser isn't actually using.
    logEvent("fingerprint.timezone_override_failed", {
      timezone: fp.timezone,
      error: tzErr.message?.substring(0, 100),
    });
  }

  await page.evaluateOnNewDocument((f) => {
    Object.defineProperty(navigator, "platform", { get: () => f.platform });
    Object.defineProperty(navigator, "language", { get: () => f.locale });
    Object.defineProperty(navigator, "languages", { get: () => [f.locale, "en"] });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => f.hardwareConcurrency });
    Object.defineProperty(navigator, "deviceMemory", { get: () => f.deviceMemory });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => f.touchSupport.maxTouchPoints });

    Object.defineProperty(screen, "width", { get: () => f.screen.width });
    Object.defineProperty(screen, "height", { get: () => f.screen.height });
    Object.defineProperty(screen, "availWidth", { get: () => f.screen.availWidth });
    Object.defineProperty(screen, "availHeight", { get: () => f.screen.availHeight });
    Object.defineProperty(screen, "colorDepth", { get: () => f.screen.colorDepth });
    Object.defineProperty(screen, "pixelDepth", { get: () => f.screen.pixelDepth });

    const origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return f.webgl.vendor;
      if (param === 37446) return f.webgl.renderer;
      return origGetParam.call(this, param);
    };
    const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return f.webgl.vendor;
      if (param === 37446) return f.webgl.renderer;
      return origGetParam2.call(this, param);
    };
  }, fp);
}

/**
 * Derive a Client Hints (userAgentData) object consistent with the chosen
 * User-Agent. Anti-bots probe the consistency between UA string, userAgentData,
 * and sec-ch-ua headers — setting UA alone via setUserAgent() leaves
 * userAgentData stale, which is a known detection vector. Puppeteer's
 * setUserAgent accepts a companion userAgentData that propagates to both
 * navigator.userAgentData and the sec-ch-ua request headers.
 */
function userAgentDataFor(fp) {
  // Parse the Chrome/SEC version from the UA to keep brands consistent.
  const chromeVersionMatch = fp.userAgent.match(/Chrome\/(\d+)/);
  const majorVersion = chromeVersionMatch ? parseInt(chromeVersionMatch[1], 10) : 131;
  const fullVersionMatch = fp.userAgent.match(/Chrome\/([\d.]+)/);
  const fullVersion = fullVersionMatch ? fullVersionMatch[1] : `${majorVersion}.0.0.0`;
  const isMobile = false;
  const platformForCh = fp.platform === "Win32" ? "Windows"
    : fp.platform === "MacIntel" ? "macOS"
    : "Linux";

  // The full Client Hints object — rebrowser-puppeteer-core enforces the
  // complete schema (architecture, bitness, platformVersion, uaFullVersion)
  // that real Chrome sends. Stock Puppeteer treated these as optional, leaving
  // an inconsistency anti-bots probe. Matching real Chrome's high-entropy hints.
  const archBitness = fp.platform === "Win32"
    ? { architecture: "x86", bitness: "64" }
    : fp.platform === "MacIntel"
      ? { architecture: "arm", bitness: "64" }
      : { architecture: "x86", bitness: "64" };

  return {
    brands: [
      { brand: "Chromium", version: String(majorVersion) },
      { brand: "Google Chrome", version: String(majorVersion) },
      { brand: "Not_A Brand", version: "24" },
    ],
    mobile: isMobile,
    platform: platformForCh,
    platformVersion: fp.platform === "Win32" ? "15.0.0"
      : fp.platform === "MacIntel" ? "14.5.0"
      : "6.5.0",
    architecture: archBitness.architecture,
    bitness: archBitness.bitness,
    model: "",
    uaFullVersion: fullVersion,
    fullVersionList: [
      { brand: "Chromium", version: fullVersion },
      { brand: "Google Chrome", version: fullVersion },
      { brand: "Not_A Brand", version: "24.0.0.0" },
    ],
  };
}

async function setPageContext(page, opts, fp) {
  // Set UA together with userAgentData so Client Hints (sec-ch-ua headers +
  // navigator.userAgentData) stay consistent with the UA string. The old call
  // setUserAgent(ua) alone left userAgentData stale — a detection vector.
  // Real Chrome accepts the full high-entropy shape via CDP; the bundled
  // Chromium-for-Testing may reject userAgentMetadata entirely (older binary),
  // so we try CDP first, then fall back to JS injection of navigator.userAgent
  // Data (covers the JS API surface even when the sec-ch-ua headers can't be
  // updated on the older binary).
  const hints = userAgentDataFor(fp);
  let cdpHintsWorked = false;
  try {
    await page.setUserAgent(fp.userAgent, { userAgentData: hints });
    cdpHintsWorked = true;
  } catch {
    // Bundled Chromium rejects userAgentMetadata — set base UA only.
    await page.setUserAgent(fp.userAgent);
  }
  if (!cdpHintsWorked) {
    // JS-layer fallback: at least make navigator.userAgentData consistent for
    // anti-bots that read the JS API (doesn't update sec-ch-ua request headers,
    // but closes the most-probed inconsistency).
    await page.evaluateOnNewDocument((h) => {
      try {
        Object.defineProperty(navigator, "userAgentData", {
          get: () => ({
            brands: h.brands,
            mobile: h.mobile,
            platform: h.platform,
            getHighEntropyValues: () => Promise.resolve({
              architecture: h.architecture,
              bitness: h.bitness,
              model: h.model,
              platformVersion: h.platformVersion,
              uaFullVersion: h.uaFullVersion,
              fullVersionList: h.fullVersionList,
            }),
          }),
        });
      } catch { /* ignore — best-effort */ }
    }, hints);
  }
  await page.setViewport(fp.viewport);

  // NOTE: the manual `navigator.webdriver` override was removed. The stealth
  // plugin handles webdriver correctly; our manual version leaked because its
  // getter's toString() returned a JS function source instead of [native code].
  // Forcing window.chrome here is also redundant — stealth covers it.

  // Proxy auth: when a proxy is configured with credentials, authenticate
  // BEFORE any navigation. This is the canonical Puppeteer method (CDP
  // Fetch.enable) and the only way residential proxies (BrightData/Smartproxy/
  // Oxylabs) work — the --proxy-server flag cannot carry credentials.
  if (opts.proxyUser || opts.proxyPass) {
    await page.authenticate({
      username: opts.proxyUser || "",
      password: opts.proxyPass || "",
    });
  }

  if (opts.headers) {
    await page.setExtraHTTPHeaders(opts.headers);
  }
  if (opts.cookies && opts.cookies.length > 0) {
    await page.setCookie(...opts.cookies);
  }
}

async function scrollPage(page, scrollCount, scrollDelay) {
  await page.evaluate(async (count, delay) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < count; i++) {
      window.scrollBy(0, window.innerHeight + Math.floor(Math.random() * 400 + 100));
      await wait(delay + Math.floor(Math.random() * 300));
    }
    window.scrollTo(0, 0);
  }, scrollCount, scrollDelay);
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSearchResults(engine, rawResults, count) {
  const seen = new Set();
  const normalized = [];

  for (const raw of rawResults || []) {
    if (normalized.length >= count) break;

    const rawUrl = cleanText(raw?.url);
    if (!rawUrl.startsWith("http")) continue;

    const url = decodeSearchResultUrl(engine, rawUrl);
    if (!url.startsWith("http")) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = cleanText(raw?.title) || url;
    const snippet = cleanText(raw?.snippet);
    normalized.push({ title, url, snippet });
  }

  return normalized;
}

async function inspectSearchPage(page) {
  return page.evaluate(() => ({
    title: document.title || "",
    url: window.location.href || "",
    text: (document.body?.innerText || "").substring(0, 6000),
  }));
}

async function extractGoogleResults(page, count) {
  return page.evaluate((maxResults) => {
    const results = [];
    const blocks = document.querySelectorAll(
      '[data-sokoban-container], .g, [class*="kp-blk"]',
    );

    for (const block of blocks) {
      if (results.length >= maxResults) break;
      const titleEl = block.querySelector("h3");
      const linkEl = block.querySelector("a[href]");
      const snippetEl = block.querySelector(
        '[data-sncf], [style*="-webkit-line-clamp"], .VwiC3b, span[style]',
      );
      if (!titleEl || !linkEl?.href) continue;

      results.push({
        title: titleEl.textContent || "",
        url: linkEl.href,
        snippet: snippetEl ? snippetEl.textContent || "" : "",
      });
    }
    return results;
  }, count);
}

async function extractDuckDuckGoResults(page, count) {
  return page.evaluate((maxResults) => {
    const results = [];
    const blocks = document.querySelectorAll(".result, .result__body");

    for (const block of blocks) {
      if (results.length >= maxResults) break;
      const linkEl = block.querySelector("a.result__a, .result__title a[href], a[href]");
      if (!linkEl?.href) continue;
      const snippetEl = block.querySelector(".result__snippet, .result__extras");

      results.push({
        title: linkEl.textContent || "",
        url: linkEl.href,
        snippet: snippetEl ? snippetEl.textContent || "" : "",
      });
    }
    return results;
  }, count);
}

async function extractBingResults(page, count) {
  return page.evaluate((maxResults) => {
    const results = [];
    const blocks = document.querySelectorAll("li.b_algo, .b_algo");

    for (const block of blocks) {
      if (results.length >= maxResults) break;
      const linkEl = block.querySelector("h2 a[href], a[href]");
      if (!linkEl?.href) continue;
      const snippetEl = block.querySelector(".b_caption p, .b_snippet, p");

      results.push({
        title: linkEl.textContent || "",
        url: linkEl.href,
        snippet: snippetEl ? snippetEl.textContent || "" : "",
      });
    }
    return results;
  }, count);
}

async function extractBraveResults(page, count) {
  return page.evaluate((maxResults) => {
    const results = [];
    const blocks = document.querySelectorAll(".snippet, .result, .fdb, article");

    for (const block of blocks) {
      if (results.length >= maxResults) break;
      const linkEl = block.querySelector(
        "h2 a[href], h3 a[href], a[data-testid='result-title-a'], a[href]",
      );
      if (!linkEl?.href) continue;
      const snippetEl = block.querySelector("p, .snippet-description, .snippet-content");

      results.push({
        title: linkEl.textContent || "",
        url: linkEl.href,
        snippet: snippetEl ? snippetEl.textContent || "" : "",
      });
    }
    return results;
  }, count);
}

async function extractGenericSearchResults(page, count) {
  return page.evaluate((maxResults) => {
    const results = [];
    const anchors = document.querySelectorAll("main a[href], #search a[href], [role='main'] a[href]");

    for (const anchor of anchors) {
      if (results.length >= maxResults) break;
      const href = anchor.href;
      if (!href || !href.startsWith("http")) continue;
      const text = (anchor.textContent || "").trim();
      if (text.length < 8) continue;

      const container = anchor.closest("article, li, div, section") || anchor.parentElement;
      const snippetEl = container?.querySelector("p");
      const snippet = snippetEl ? snippetEl.textContent || "" : "";

      results.push({
        title: text,
        url: href,
        snippet,
      });
    }
    return results;
  }, count);
}

async function extractSearchResultsForEngine(page, engine, count) {
  switch (engine) {
    case "duckduckgo":
      return extractDuckDuckGoResults(page, count);
    case "bing":
      return extractBingResults(page, count);
    case "brave":
      return extractBraveResults(page, count);
    case "google":
      return extractGoogleResults(page, count);
    default:
      return extractGenericSearchResults(page, count);
  }
}

/**
 * Apply an extraction strategy to a loaded page. Replaces the old
 * `applyLoadMethod` switch with a unified model:
 *
 * - auto:     detect challenge → wait for resolution → network-idle →
 *             content-check → (SPA-wait if empty) → (scroll if feed detected).
 *             The caller doesn't need to be a scraping expert.
 * - fast:     network-idle only (legacy `direct`).
 * - patient:  selector-wait or network-idle + renderWait (legacy `wait`/`timed`).
 * - spa:      network-idle + render wait for client-rendered apps.
 * - scroll:   infinite-scroll loop + network-idle.
 *
 * Returns a `challenge` field in the result describing any challenge handling
 * (detected, kind, resolved, waitedMs). The caller surfaces it in meta.
 *
 * @returns {Promise<{ challenge: object | null }>}
 */
async function applyStrategy(page, options) {
  const {
    strategy,
    selector,
    timeout,
    renderWait,
    scrollCount,
    scrollDelay,
    bypassChallenges,
    challengeTimeout,
  } = options;

  let challenge = null;

  // Challenge handling: auto always does it; other strategies opt in via
  // bypassChallenges. Runs BEFORE the strategy-specific wait so a cleared
  // challenge doesn't get mistaken for empty content.
  const handleChallenges = strategy === "auto" || bypassChallenges;
  if (handleChallenges && challengeTimeout > 0) {
    const resolution = await waitForChallengeResolution(page, {
      timeoutMs: challengeTimeout * 1000,
    });
    if (resolution.detected) {
      challenge = resolution;
      if (!resolution.resolved) {
        // Honest failure: return the challenge info so the caller knows the
        // extraction did NOT succeed against a live challenge page. The page
        // extraction still proceeds (best-effort) but the challenge field lets
        // the engine mark the outcome. Interactive/timedOut challenges are
        // surfaced via errorCode below in runNsectEngine.
        return { challenge };
      }
    }
  }

  switch (strategy) {
    case "auto": {
      await page.waitForNetworkIdle({ timeout: timeout * 1000 }).catch(() => {});
      // Content presence check: if the page is empty, treat it as a SPA that
      // needs render time and wait briefly before re-checking.
      if (!(await hasSubstantiveContent(page))) {
        await new Promise((r) => setTimeout(r, (renderWait || 3) * 1000));
      }
      // Infinite-scroll detection: if a feed sentinel is present, scroll.
      if (await detectInfiniteScroll(page)) {
        await scrollPage(page, scrollCount, scrollDelay);
        await page.waitForNetworkIdle({ timeout: 10_000 }).catch(() => {});
      }
      break;
    }
    case "fast":
      await page.waitForNetworkIdle({ timeout: timeout * 1000 }).catch(() => {});
      break;
    case "patient":
      if (selector) {
        await page.waitForSelector(selector, { timeout: timeout * 1000 }).catch(() => {});
      } else {
        await page.waitForNetworkIdle({ timeout: timeout * 1000 }).catch(() => {});
      }
      if (renderWait > 0) {
        await new Promise((r) => setTimeout(r, renderWait * 1000));
      }
      break;
    case "spa":
      await page.waitForNetworkIdle({ timeout: timeout * 1000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, (renderWait || 3) * 1000 + randomInt(0, 1000)));
      break;
    case "scroll":
      await scrollPage(page, scrollCount, scrollDelay);
      await page.waitForNetworkIdle({ timeout: 10_000 }).catch(() => {});
      break;
  }

  return { challenge };
}

async function runSearchWithFallback(page, options) {
  const {
    query,
    count,
    engines,
    strategy,
    selector,
    timeout,
    renderWait,
    scrollCount,
    scrollDelay,
    bypassChallenges,
    challengeTimeout,
  } = options;

  const attempts = [];
  let selectedEngine = null;
  let results = [];

  for (const engine of engines) {
    const searchUrl = buildSearchUrl(engine, query, count);

    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeout * 1000,
      });

      await applyStrategy(page, {
        strategy,
        selector,
        timeout,
        renderWait,
        scrollCount,
        scrollDelay,
        bypassChallenges,
        challengeTimeout,
      });

      const pageSnapshot = await inspectSearchPage(page);
      const blocked = isSearchBlocked({ engine, ...pageSnapshot });
      // Also check for challenge pages that isSearchBlocked's text patterns
      // might miss (CF "Just a moment" etc.). A late challenge detect on the
      // search result page catches blocks the blocklist doesn't cover.
      let challengeBlocked = false;
      if (!blocked) {
        const searchChallenge = await detectChallenge(page);
        if (searchChallenge?.detected && !searchChallenge?.autoResolvable) {
          challengeBlocked = true;
        }
      }
      if (blocked || challengeBlocked) {
        attempts.push({
          engine,
          engineLabel: searchEngineLabel(engine),
          url: searchUrl,
          blocked: true,
          resultCount: 0,
          reason: "blocked",
        });
        continue;
      }

      const rawResults = await extractSearchResultsForEngine(page, engine, count);
      const normalizedResults = normalizeSearchResults(engine, rawResults, count);
      attempts.push({
        engine,
        engineLabel: searchEngineLabel(engine),
        url: searchUrl,
        blocked: false,
        resultCount: normalizedResults.length,
        reason: normalizedResults.length > 0 ? "ok" : "no_results",
      });

      if (normalizedResults.length > 0) {
        selectedEngine = engine;
        results = normalizedResults;
        break;
      }
    } catch (err) {
      attempts.push({
        engine,
        engineLabel: searchEngineLabel(engine),
        url: searchUrl,
        blocked: false,
        resultCount: 0,
        reason: "error",
        error: err.message,
      });
    }
  }

  return {
    selectedEngine,
    results,
    attempts,
  };
}

export async function runNsectEngine(params) {
  // Extract non-request fields that normalization would strip, then re-attach.
  const { solver } = params;
  const normalized = normalizeEngineRequest(params, {
    allowFileOutput: true,
    allowHeadful: true,
  });
  // Re-attach the solver config so the challenge-blocked branch can use it.
  normalized.solver = solver;
  const {
    url,
    query,
    strategy,
    format,
    verbose,
    selector,
    timeout,
    renderWait,
    challengeTimeout,
    bypassChallenges,
    scrollCount,
    scrollDelay,
    proxy,
    proxyUser,
    proxyPass,
    cookies,
    headers,
    delay,
    maxResults,
    searchEngines,
    listLinks,
    screenshotPath,
    pdfPath,
    headless,
  } = normalized;

  const fp = generateFingerprint();
  const startTime = Date.now();
  const isSearchRequest = Boolean(query);

  let browser;
  try {
    browser = await buildBrowser({ proxy, timeout, headless }, fp);
  } catch (launchErr) {
    return {
      success: false,
      output: null,
      errorCode: "BROWSER_LAUNCH",
      error: `Browser launch failed: ${launchErr.message}. Ensure Chromium is installed (npm run install-browser).`,
    };
  }

  try {
    const page = await browser.newPage();
    await injectFingerprint(page, fp);
    await setPageContext(page, { cookies, headers, proxyUser, proxyPass }, fp);

    page.setDefaultNavigationTimeout(timeout * 1000);
    page.setDefaultTimeout(timeout * 1000);

    const preDelay = delay + randomInt(0, 500);
    await new Promise((r) => setTimeout(r, preDelay));
    let searchState = null;
    let pageState = null;
    let challengeInfo = null;

    if (isSearchRequest) {
      searchState = await runSearchWithFallback(page, {
        query,
        count: maxResults,
        engines: searchEngines,
        strategy,
        selector,
        timeout,
        renderWait,
        scrollCount,
        scrollDelay,
        bypassChallenges,
        challengeTimeout,
      });
    } else {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeout * 1000,
      });

      const strategyResult = await applyStrategy(page, {
        strategy,
        selector,
        timeout,
        renderWait,
        scrollCount,
        scrollDelay,
        bypassChallenges,
        challengeTimeout,
      });
      challengeInfo = strategyResult.challenge;

      // Honest failure: if a challenge was detected and NOT resolved, try the
      // solver if configured for this challenge kind, then fail honestly if
      // the solver can't help (no solver configured, kind not eligible, or
      // solve attempt failed).
      if (challengeInfo?.detected && !challengeInfo?.resolved) {
        const solverCfg = normalized.solver;
        const eligible = isSolverEligible(challengeInfo.kind)
          && solverCfg?.enabled
          && solverCfg.kinds.includes(challengeInfo.kind);

        if (eligible) {
          try {
            const solveResult = await attemptSolve(page, challengeInfo, solverCfg, fp);
            if (solveResult.resolved) {
              challengeInfo = { ...challengeInfo, resolved: true, solved: true };
              // Fall through to extraction below.
            }
          } catch (solverErr) {
            return {
              success: false,
              output: null,
              errorCode: "CHALLENGE_BLOCKED",
              error: `Challenge from ${challengeInfo.label} could not be solved: ${solverErr.message}`,
              meta: {
                type: "page",
                challenge: { ...challengeInfo, resolved: false, solverError: solverErr.code },
                url,
                elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
              },
            };
          }
        } else {
          return {
            success: false,
            output: null,
            errorCode: "CHALLENGE_BLOCKED",
            error: `Challenge from ${challengeInfo.label} was detected but could not be resolved${challengeInfo.interactive ? " (interactive challenge — needs a solver service)" : " within the challenge timeout"}.`,
            meta: {
              type: "page",
              challenge: challengeInfo,
              url,
              elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
            },
          };
        }
      }

      pageState = await extractWithCascade(page, { verbose, noiseSelectors: NOISE_SELECTORS });

      // Empty-content guard: if extraction yielded near-zero text, the page is
      // almost certainly a bot-detection interstitial (PerimeterX/imperva serve
      // blank pages) that the pre-extraction challenge probe missed. Run a late
      // detection and, if still empty, fail honestly instead of returning
      // success with no content (the silent-wrong-answer failure mode).
      if (!verbose && (pageState.text?.trim().length ?? 0) < 50) {
        const lateChallenge = await detectChallenge(page);
        if (lateChallenge) {
          return {
            success: false,
            output: null,
            errorCode: "CHALLENGE_BLOCKED",
            error: `Challenge from ${lateChallenge.label} was detected (empty-content interstitial) and could not be resolved.`,
            meta: {
              type: "page",
              challenge: { ...lateChallenge, detected: true, resolved: false, waitedMs: 0 },
              url,
              elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
            },
          };
        }
      }
    }

    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    if (pdfPath) {
      await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    if (isSearchRequest) {
      const output = formatGoogleResults(searchState.results, format);
      return {
        success: true,
        format,
        output,
        meta: {
          type: "search",
          query,
          engine: searchState.selectedEngine,
          engineLabel: searchState.selectedEngine
            ? searchEngineLabel(searchState.selectedEngine)
            : null,
          engineOrder: searchEngines,
          attempts: searchState.attempts,
          resultCount: searchState.results.length,
          strategy,
          challenge: challengeInfo,
          elapsed,
          artifacts: {
            screenshotPath: screenshotPath || null,
            pdfPath: pdfPath || null,
          },
          fingerprint: {
            userAgent: fp.userAgent,
            viewport: fp.viewport,
            locale: fp.locale,
            timezone: fp.timezone,
          },
        },
      };
    }

    const output = formatOutput(pageState, format);

    return {
      success: true,
      format,
      output,
      meta: {
        type: "page",
        title: pageState.title,
        url: pageState.url,
        textLength: pageState.text.length,
        linksFound: pageState.links.length,
        links: listLinks ? pageState.links : undefined,
        // Structured data from the extraction cascade (defuddle tier).
        author: pageState.author || undefined,
        published: pageState.published || undefined,
        schemaOrg: pageState.schemaOrg?.length ? pageState.schemaOrg : undefined,
        strategy,
        challenge: challengeInfo,
        elapsed,
        artifacts: {
          screenshotPath: screenshotPath || null,
          pdfPath: pdfPath || null,
        },
        fingerprint: {
          userAgent: fp.userAgent,
          viewport: fp.viewport,
          locale: fp.locale,
          timezone: fp.timezone,
        },
      },
    };
  } catch (err) {
    return {
      success: false,
      output: null,
      errorCode: "UPSTREAM_REQUEST",
      error: err.message,
    };
  } finally {
    // Guard browser.close() — if the browser process is already dead or in a
    // bad state, close() can throw and mask the original error from the catch
    // block above. Never let cleanup failure shadow the real failure.
    try {
      await browser.close();
    } catch {
      // Best-effort cleanup; the original error (if any) is already captured.
    }
  }
}

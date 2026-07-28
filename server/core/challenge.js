/**
 * Challenge detection + resolution layer.
 *
 * The explicit "bypass JS challenges" capability. Many bot-protection systems
 * (Cloudflare, DataDome, PerimeterX) serve a JS challenge page that
 * auto-resolves after 5-15 seconds WHEN the browser fingerprint passes their
 * automation checks. The existing stealth stack (puppeteer-extra-plugin-stealth
 * + fingerprint injection) provides that detection resistance. This module
 * adds the patience: detect the challenge page, wait for self-resolution, and
 * report honestly whether it cleared.
 *
 * Three challenge classes:
 *   1. Auto-resolvable JS challenges  -> wait, re-check, extract once cleared
 *   2. Interactive challenges          -> detect, do NOT solve, fail honestly
 *   3. Hard blocks (403/captcha walls) -> detect, fail honestly
 *
 * The honest failure is load-bearing: previously a challenge page was extracted
 * as if it were content (success: true with garbage). Now unresolved challenges
 * return errorCode: "CHALLENGE_BLOCKED" so the caller knows to retry, escalate,
 * or use a solver service — instead of trusting a wrong answer.
 */

/**
 * Challenge signature. Each entry names a protection system and the signals
 * that identify its challenge page. Signals are checked in order; the first
 * match wins so the kind is reported accurately.
 *
 * @typedef {Object} ChallengeSignature
 * @property {string} kind          Machine-readable kind (cloudflare, datadome, etc.)
 * @property {string} label         Human-readable name.
 * @property {boolean} autoResolvable  Whether the JS challenge typically self-clears.
 * @property {RegExp[]} [urlPatterns]   Patterns matched against the page URL.
 * @property {string[]} [domMarkers]    CSS-like selectors checked for presence.
 * @property {RegExp[]} [textPatterns]  Patterns matched against page text.
 */

/** @type {ChallengeSignature[]} */
const CHALLENGE_SIGNATURES = [
  {
    kind: "cloudflare",
    label: "Cloudflare",
    autoResolvable: true,
    urlPatterns: [/^\/cdn-cgi\/challenge/, /\/cdn-cgi\/turnstile/],
    domMarkers: ["#cf-challenge", "#challenge-form", "#cf-please-wait", ".cf-browser-verification"],
    textPatterns: [/just a moment/i, /checking your browser/i, /cf-challenge/i, /enable javascript.*cloudflare/i],
  },
  {
    kind: "cloudflare_turnstile",
    label: "Cloudflare Turnstile",
    autoResolvable: false,
    domMarkers: ["iframe[src*='challenges.cloudflare.com']", ".cf-turnstile"],
    textPatterns: [/verify you are human/i],
  },
  {
    kind: "datadome",
    label: "DataDome",
    autoResolvable: true,
    urlPatterns: [/_dd_s\b/, /\/_dd\b/],
    domMarkers: ["iframe[src*='datadome']", "#datadome", ".dd-pp-list"],
    textPatterns: [/datadome/i, /please verify you are a person/i],
  },
  {
    kind: "perimeterx",
    label: "PerimeterX / HUMAN",
    autoResolvable: true,
    urlPatterns: [/\/_pxhl\//, /\/px\.js/],
    domMarkers: ["#px-captcha", "iframe[src*='px-captcha']", "script[src*='px-captcha']"],
    textPatterns: [/press.*hold/i, /perimeterx/i, /are you a human/i],
  },
  {
    kind: "hcaptcha",
    label: "hCaptcha",
    autoResolvable: false,
    domMarkers: ["iframe[src*='hcaptcha']", ".h-captcha", "#hcaptcha-wrapper"],
    textPatterns: [/hcaptcha/i],
  },
  {
    kind: "recaptcha",
    label: "reCAPTCHA",
    autoResolvable: false,
    domMarkers: ["iframe[src*='recaptcha']", ".g-recaptcha", "#recaptcha"],
    textPatterns: [/recaptcha/i],
  },
  {
    kind: "akamai",
    label: "Akamai Bot Manager",
    autoResolvable: true,
    urlPatterns: [/_abck\b/],
    textPatterns: [/access denied.*akamai/i, /reference.*#?\d+\.\w+.*akamai/i],
  },
  {
    kind: "generic",
    label: "Generic interstitial",
    autoResolvable: true,
    textPatterns: [
      /\bplease wait\b/i,
      /\bloading\b.*\bplease\b/i,
      /\bverifying your browser/i,
      /\bchecking.*connection/i,
    ],
  },
  {
    kind: "blocked",
    label: "Hard block",
    autoResolvable: false,
    urlPatterns: [/\/sorry\//i, /\/access[-_]?denied/i],
    textPatterns: [
      /\baccess denied\b/i,
      /\b403 forbidden\b/i,
      /\btemporarily blocked\b/i,
      /\bsecurity check\b/i,
      /\bautomated queries\b/i,
    ],
  },
];

/**
 * Inspect a page for challenge signatures. Returns the first matching kind
 * (most specific first) or null if no challenge is detected. Pure-ish over the
 * page's URL + text + DOM, so it can be re-run on a polling loop.
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<{ kind: string, label: string, autoResolvable: boolean } | null>}
 */
export async function detectChallenge(page) {
  let url = "";
  let text = "";
  let markerHits = [];

  try {
    url = page.url();
  } catch { /* page may be mid-navigation */ }

  try {
    text = await page.evaluate(() => (document.body?.innerText || "").substring(0, 12_000));
  } catch { /* ignore — text is best-effort */ }

  try {
    markerHits = await page.evaluate((markers) => {
      // Flatten all selectors across signatures, check in one DOM pass.
      const hits = [];
      for (const sel of markers) {
        try {
          if (document.querySelector(sel)) hits.push(sel);
        } catch { /* invalid selector — skip */ }
      }
      return hits;
    }, CHALLENGE_SIGNATURES.flatMap((s) => s.domMarkers ?? []));
  } catch { /* ignore */ }

  for (const sig of CHALLENGE_SIGNATURES) {
    const urlHit = sig.urlPatterns?.some((p) => p.test(url)) ?? false;
    const textHit = sig.textPatterns?.some((p) => p.test(text)) ?? false;
    const domHit = sig.domMarkers?.some((m) => markerHits.includes(m)) ?? false;

    if (urlHit || textHit || domHit) {
      return { kind: sig.kind, label: sig.label, autoResolvable: sig.autoResolvable };
    }
  }

  // Empty-page heuristic: PerimeterX/imperva and some bot-detection systems
  // serve a near-blank interstitial (often a JS redirect or puzzle iframe)
  // with NO text markers and NO captcha DOM elements. The reliable signal is
  // the combination of TRULY empty visible text AND a title that is just the
  // bare hostname (real pages have descriptive titles).
  //
  // Important: do NOT fire on merely-short content. Chrome's own cert/error
  // interstitials have short text + hostname title but are NOT bot blocks —
  // distinguishing them requires the text to be essentially zero (a PX blank
  // redirect serves no visible text at all). This avoids false-positives on
  // legitimate interstitial pages (badssl cert warnings, etc.).
  const textStripped = text.trim();
  const isTrulyEmpty = textStripped.length === 0;
  if (isTrulyEmpty) {
    let title = "";
    try {
      title = await page.title();
    } catch { /* best-effort */ }
    const bareHost = (() => {
      try { return new URL(url).hostname; } catch { return ""; }
    })();
    // Title equals the bare hostname (e.g. "yelp.com") OR is empty — both are
    // strong indicators of an interstitial block, not real content.
    const titleLooksLikeBlock = !title || title === bareHost || title === bareHost.replace(/^www\./, "");
    if (titleLooksLikeBlock) {
      return { kind: "blocked", label: "Bot-detection empty interstitial", autoResolvable: false };
    }
  }

  return null;
}

/**
 * Wait for an auto-resolvable challenge to clear. Polls detectChallenge() every
 * `pollIntervalMs`; returns as soon as no challenge is detected or the budget
 * expires. Does NOT attempt interactive challenges — those need a solver.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options]
 * @returns {Promise<{ detected: true, kind: string, label: string, resolved: boolean, waitedMs: number }>}
 */
export async function waitForChallengeResolution(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const start = Date.now();

  const initial = await detectChallenge(page);
  if (!initial) {
    return { detected: false, kind: null, label: null, resolved: true, waitedMs: 0 };
  }

  // Interactive / hard challenges cannot self-clear — report immediately so the
  // caller gets a fast, honest failure instead of burning the whole budget.
  if (!initial.autoResolvable) {
    return {
      detected: true,
      kind: initial.kind,
      label: initial.label,
      resolved: false,
      waitedMs: 0,
      interactive: true,
    };
  }

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const recheck = await detectChallenge(page);
    if (!recheck) {
      return {
        detected: true,
        kind: initial.kind,
        label: initial.label,
        resolved: true,
        waitedMs: Date.now() - start,
      };
    }
  }

  return {
    detected: true,
    kind: initial.kind,
    label: initial.label,
    resolved: false,
    waitedMs: Date.now() - start,
    timedOut: true,
  };
}

/**
 * The default challenge-resolution budget for the `auto` strategy. Generous
 * enough for Cloudflare/DataDome (typically 5-10s) but bounded so a stuck
 * challenge fails fast rather than hanging the whole request.
 */
export const DEFAULT_CHALLENGE_TIMEOUT_MS = 15_000;

/**
 * Check whether content is "real" (not a blank/interstitial) by measuring
 * visible text length. Used by the auto strategy to decide whether to wait
 * longer for a SPA/challenge render.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ minLength?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function hasSubstantiveContent(page, options = {}) {
  const minLength = options.minLength ?? 200;
  try {
    const length = await page.evaluate(
      (min) => (document.body?.innerText || "").trim().length >= min,
      minLength,
    );
    return Boolean(length);
  } catch {
    return false;
  }
}

/**
 * Detect whether the page has an infinite-scroll container (lazy-loaded feed).
 * Heuristic: presence of common sentinel elements OR a "load more" pattern.
 *
 * @param {import("puppeteer").Page} page
 * @returns {Promise<boolean>}
 */
export async function detectInfiniteScroll(page) {
  try {
    return await page.evaluate(() => {
      const sentinels = document.querySelectorAll(
        "[data-pagination], [data-load-more], [data-infinite-scroll], .infinite-scroll, .load-more, #load-more, [role='feed']",
      );
      if (sentinels.length > 0) return true;
      // IntersectionObserver-based lazy loaders are a strong SPA-feed signal.
      const feed = document.querySelector("[class*='feed'], [class*='Feed'], main");
      return Boolean(feed) && document.documentElement.scrollHeight > window.innerHeight * 3;
    });
  } catch {
    return false;
  }
}

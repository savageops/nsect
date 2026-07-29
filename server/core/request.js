import { FORMATS, METHODS } from "./fingerprint.js";
import { normalizeSearchEngines } from "./search.js";

const LIMITS = {
  timeout: { min: 1, max: 180, defaultValue: 30 },
  renderWait: { min: 0, max: 120, defaultValue: 0 },
  challengeTimeout: { min: 0, max: 120, defaultValue: 15 },
  scrollCount: { min: 1, max: 500, defaultValue: 20 },
  scrollDelay: { min: 50, max: 10_000, defaultValue: 800 },
  delay: { min: 0, max: 30_000, defaultValue: 1000 },
  googleCount: { min: 1, max: 50, defaultValue: 10 },
};

/**
 * Unified extraction strategies. The `method` field is a legacy alias mapped
 * onto these for backward compatibility; `strategy` is the canonical name.
 *
 * - auto:      detect challenges + wait for resolution, detect SPA/scroll, then
 *              extract. The 90% default — the caller doesn't need to be an expert.
 * - fast:      static pages, minimum wait (legacy `direct`).
 * - patient:   slow renders, extra wait (legacy `wait`/`timed`).
 * - spa:       client-rendered apps.
 * - scroll:    infinite feeds.
 */
const STRATEGIES = Object.freeze(["auto", "fast", "patient", "spa", "scroll"]);

/**
 * Map a legacy `method` value to the canonical `strategy`. Old callers keep
 * working; the internal engine only reasons about strategies.
 */
const METHOD_TO_STRATEGY = Object.freeze({
  direct: "fast",
  wait: "patient",
  timed: "patient",
  spa: "spa",
  scroll: "scroll",
});

const SUPPORTED_SCRAPE_METHODS = Object.freeze(Object.keys(METHODS));
const SUPPORTED_FORMATS = Object.freeze([...FORMATS]);

export class RequestValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "RequestValidationError";
    this.code = "VALIDATION_ERROR";
    this.field = field;
  }
}

export { STRATEGIES as SUPPORTED_STRATEGIES };

function toOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function toInteger(value, field, { min, max, defaultValue }) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    throw new RequestValidationError(`'${field}' must be an integer`, field);
  }
  if (numeric < min || numeric > max) {
    throw new RequestValidationError(
      `'${field}' must be between ${min} and ${max}`,
      field,
    );
  }
  return numeric;
}

function parseObjectLike(value, field) {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new RequestValidationError(
        `'${field}' must be valid JSON when provided as a string`,
        field,
      );
    }
  }

  if (typeof value === "object") return value;

  throw new RequestValidationError(`'${field}' must be an object or JSON string`, field);
}

function parseHeaders(value) {
  const parsed = parseObjectLike(value, "headers");
  if (parsed === undefined) return undefined;
  if (Array.isArray(parsed) || parsed === null) {
    throw new RequestValidationError("'headers' must be a plain object", "headers");
  }
  return parsed;
}

function parseCookies(value) {
  const parsed = parseObjectLike(value, "cookies");
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) {
    throw new RequestValidationError("'cookies' must be an array", "cookies");
  }
  return parsed;
}

/**
 * Parse proxy configuration into the three fields the engine needs: the host
 * URL (for --proxy-server), and optional user/pass (for page.authenticate()).
 *
 * Accepts three forms:
 *   1. proxy = "http://host:port"            (no auth)
 *   2. proxy = "http://user:pass@host:port"  (embedded auth — credentials
 *      extracted and stripped from the host URL, since --proxy-server can't
 *      carry them)
 *   3. proxy = "http://host:port" + separate proxyUser/proxyPass (the
 *      BrightData/Smartproxy pattern where the username encodes zone/session)
 *
 * @returns {{ proxy?: string, proxyUser?: string, proxyPass?: string }}
 */
function parseProxy(proxyValue, proxyUser, proxyPass) {
  const proxy = toOptionalString(proxyValue);
  if (!proxy) return {};

  let host = proxy;
  let user = toOptionalString(proxyUser);
  let pass = toOptionalString(proxyPass);

  // Use the URL API to authoritatively parse embedded credentials. Regex
  // approaches break on passwords containing @ or URL-encoded chars. The URL
  // constructor handles all encoding correctly and lets us strip creds from
  // the host URL in one place (the single owner of credential extraction).
  try {
    const parsed = new URL(proxy);
    if (parsed.username && !user) {
      user = decodeURIComponent(parsed.username);
    }
    if (parsed.password && !pass) {
      pass = decodeURIComponent(parsed.password);
    }
    // Rebuild the host URL without credentials — --proxy-server can't carry auth.
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      host = parsed.toString();
    }
  } catch {
    // Not a parseable URL (e.g., "host:port" without scheme) — leave as-is.
    // The engine's buildBrowser handles the --proxy-server flag directly.
  }

  return { proxy: host, proxyUser: user, proxyPass: pass };
}

function assertUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new RequestValidationError(
        "'url' must use http:// or https://",
        "url",
      );
    }
  } catch {
    throw new RequestValidationError("'url' must be a valid absolute URL", "url");
  }
}

/**
 * Normalize the extraction strategy. Accepts the canonical `strategy` field or
 * the legacy `method` field (mapped to its strategy equivalent). This collapses
 * the old 5-method decision tree into a single concept with a smart `auto`
 * default — callers no longer need to know whether a site is static, a SPA, or
 * a feed.
 *
 * @param {*} strategyValue  The canonical `strategy` field.
 * @param {*} methodValue    The legacy `method` field (backward-compat alias).
 * @returns {string}  One of STRATEGIES.
 */
function normalizeStrategy(strategyValue, methodValue) {
  const strategy = toOptionalString(strategyValue);
  const method = toOptionalString(methodValue);

  if (strategy) {
    if (!STRATEGIES.includes(strategy)) {
      throw new RequestValidationError(
        `Unknown strategy. Valid: ${STRATEGIES.join(", ")}`,
        "strategy",
      );
    }
    return strategy;
  }

  if (method) {
    if (!SUPPORTED_SCRAPE_METHODS.includes(method)) {
      throw new RequestValidationError(
        `Unknown method. Valid: ${SUPPORTED_SCRAPE_METHODS.join(", ")}`,
        "method",
      );
    }
    return METHOD_TO_STRATEGY[method] || "auto";
  }

  return "auto";
}

function normalizeFormat(value) {
  const format = toOptionalString(value) || "text";
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new RequestValidationError(
      `Unknown format. Valid: ${SUPPORTED_FORMATS.join(", ")}`,
      "format",
    );
  }
  return format;
}

function ensureFileOutputAllowed(pathValue, field, allowFileOutput) {
  if (!pathValue) return undefined;
  if (!allowFileOutput) {
    throw new RequestValidationError(
      `'${field}' is only supported for local CLI usage`,
      field,
    );
  }
  return pathValue;
}

export function normalizeEngineRequest(
  input = {},
  { allowFileOutput = false, allowHeadful = false } = {},
) {
  const url = toOptionalString(input.url);
  const google = toOptionalString(input.google);
  const query = toOptionalString(input.query);

  if (google && query && google !== query) {
    throw new RequestValidationError(
      "When both 'google' and 'query' are provided, they must match",
      "query",
    );
  }
  const searchQuery = query || google;

  if (!url && !searchQuery) {
    throw new RequestValidationError(
      "Either --url or --google/--query is required.",
      "url",
    );
  }
  if (url) assertUrl(url);

  const strategy = normalizeStrategy(input.strategy, input.method);
  const selector = toOptionalString(input.selector);
  if (!searchQuery && strategy === "patient" && !selector && input.method === "wait") {
    throw new RequestValidationError(
      "method='wait' requires a non-empty 'selector'",
      "selector",
    );
  }

  let searchEngines;
  try {
    searchEngines = normalizeSearchEngines(
      input.searchEngines ?? input.search_engines ?? input.engines,
    );
  } catch (err) {
    throw new RequestValidationError(err.message, "searchEngines");
  }

  const normalized = {
    url,
    query: searchQuery,
    google: searchQuery,
    strategy,
    // Legacy `method` kept for backward-compat with consumers that read it.
    method: strategy,
    format: normalizeFormat(input.format),
    verbose: toBoolean(input.verbose, false),
    selector,
    timeout: toInteger(input.timeout, "timeout", LIMITS.timeout),
    // renderWait: extra time to wait for slow renders (replaces the old `timed`
    // method's overloaded `timeout` semantics). Default 0 for fast; strategies
    // that need patience bump it internally.
    renderWait: toInteger(
      input.renderWait ?? input.render_wait,
      "renderWait",
      LIMITS.renderWait,
    ),
    // challengeTimeout: budget for the auto-resolvable challenge layer (point 2).
    // 0 disables challenge handling; default 15s covers Cloudflare/DataDome.
    challengeTimeout: toInteger(
      input.challengeTimeout ?? input.challenge_timeout,
      "challengeTimeout",
      LIMITS.challengeTimeout,
    ),
    // bypassChallenges: explicit opt-in to the challenge resolution layer for
    // non-auto strategies. Auto enables it by default.
    bypassChallenges: toBoolean(input.bypassChallenges ?? input.bypass_challenges, false),
    scrollCount: toInteger(
      input.scrollCount ?? input.scroll_count,
      "scrollCount",
      LIMITS.scrollCount,
    ),
    scrollDelay: toInteger(
      input.scrollDelay ?? input.scroll_delay,
      "scrollDelay",
      LIMITS.scrollDelay,
    ),
    delay: toInteger(input.delay, "delay", LIMITS.delay),
    // maxResults is the clear name; googleCount kept as a legacy alias.
    maxResults: toInteger(
      input.maxResults ?? input.max_results ?? input.googleCount ?? input.google_count,
      "maxResults",
      LIMITS.googleCount,
    ),
    searchEngines,
    ...parseProxy(input.proxy, input.proxyUser ?? input.proxy_user, input.proxyPass ?? input.proxy_pass),
    cookies: parseCookies(input.cookies),
    headers: parseHeaders(input.headers),
    listLinks: toBoolean(input.listLinks ?? input["list-links"], false),
    screenshotPath: ensureFileOutputAllowed(
      toOptionalString(input.screenshot ?? input.screenshotPath),
      "screenshot",
      allowFileOutput,
    ),
    pdfPath: ensureFileOutputAllowed(
      toOptionalString(input.pdf ?? input.pdfPath),
      "pdf",
      allowFileOutput,
    ),
  };
  // Keep googleCount as an alias of maxResults for legacy readers.
  normalized.googleCount = normalized.maxResults;

  const requestedHeadless = input["no-headless"] ? false : toBoolean(input.headless, true);
  normalized.headless = allowHeadful ? requestedHeadless : true;

  return normalized;
}


export function requestValidationToHttp(err) {
  if (!(err instanceof RequestValidationError)) return null;
  return {
    status: 400,
    body: {
      error: err.message,
      code: err.code,
      field: err.field,
    },
  };
}

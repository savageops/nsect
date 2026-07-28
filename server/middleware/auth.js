/**
 * Authentication + admission middleware.
 *
 * The engine + transcript routes are guarded by `apiKeyAuth`, which is a
 * conditional security surface (50-security-runtime): in local mode it is a
 * no-op pass-through (the developer's machine is the trust boundary), and in
 * hosted mode it enforces key validation, rate limiting, and the 6-second
 * per-key search cooldown.
 *
 * `adminRateLimiter` is an in-memory per-IP limiter for the /api/keys admin
 * routes (hosted only). It closes the "unbounded key minting" hole (point 4)
 * where a leaked admin secret would otherwise allow unlimited creation. It is
 * intentionally simple and process-local — multi-host deployments need a shared
 * store (Redis), documented as residual.
 *
 * Admin authentication is header-only (`x-admin-key`), distinct from the
 * API-key `Authorization: Bearer` transport. Two schemes, two transports — no
 * ambiguous shared parsing (point 11c).
 */

import { validateKey, safeCompareSecret } from "../db/keys.js";
import { getRuntimeConfig } from "../core/config.js";
import { MIN_SEARCH_COOLDOWN_SECONDS } from "../core/contracts.js";
import { firstHeaderValue, readBearerToken } from "../core/http-headers.js";

const ADMIN_RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_RATE_LIMIT_MAX = 10;

/** @type {Map<string, { windowStart: number, count: number }>} */
const adminIpWindows = new Map();

function readApiKey(req) {
  const headerKey = firstHeaderValue(req.headers["x-api-key"]);
  if (headerKey) return headerKey;

  const bearerValue = readBearerToken(req.headers.authorization);
  if (bearerValue) return bearerValue;
  return null;
}

function shouldEnforceSearchCooldown(req) {
  const query = req.body?.query ?? req.body?.google;
  return typeof query === "string" && query.trim().length > 0;
}

/**
 * Engine/transcript admission gate.
 *
 * Local mode: no-op — runs freely without keys, rate limits, or cooldowns.
 * Hosted mode: validates the presented key and enforces rate limit + cooldown.
 */
export function apiKeyAuth(req, res, next) {
  const { hosted } = getRuntimeConfig();

  // Local mode: the trust boundary is the local machine. No gating.
  if (!hosted) return next();

  const key = readApiKey(req);

  if (!key) {
    return res.status(401).json({ error: "API key required. Pass x-api-key header or Authorization: Bearer <key>." });
  }

  const result = validateKey(key, {
    enforceSearchCooldown: shouldEnforceSearchCooldown(req),
  });

  if (!result.valid) {
    const messages = {
      not_found: "Invalid API key.",
      revoked: "API key has been revoked.",
      expired: "API key has expired.",
      rate_limited: `Rate limit exceeded. Retry after ${result.retryAfter}s.`,
      cooldown: `Search cooldown active. Retry after ${result.retryAfter}s. Minimum ${result.cooldownSeconds || MIN_SEARCH_COOLDOWN_SECONDS}s between search queries per API key.`,
    };
    const status = result.reason === "rate_limited" || result.reason === "cooldown" ? 429 : 403;
    return res.status(status).json({
      error: messages[result.reason] || "Invalid API key.",
      code: result.reason || "invalid_key",
      retryAfter: Number.isFinite(result.retryAfter) ? result.retryAfter : undefined,
      cooldownSeconds: Number.isFinite(result.cooldownSeconds)
        ? result.cooldownSeconds
        : (result.reason === "cooldown" ? MIN_SEARCH_COOLDOWN_SECONDS : undefined),
    });
  }

  next();
}

/**
 * Admin admission gate for /api/keys/* routes.
 *
 * Validates the admin secret via a timing-safe comparison (point 2) against the
 * configured ADMIN_KEY (which is guaranteed non-empty in hosted mode by the
 * config owner). Bounded by adminRateLimiter to prevent brute-force / minting
 * floods (point 4).
 *
 * @param {string} adminKey  The configured admin secret (non-empty in hosted).
 */
export function adminAuth(adminKey) {
  return function adminAuthMiddleware(req, res, next) {
    const presented = firstHeaderValue(req.headers["x-admin-key"]);
    // Header-only admin auth — no Bearer ambiguity with API keys (point 11c).
    if (!presented || !safeCompareSecret(presented, adminKey)) {
      return res.status(403).json({
        error: "Admin key required via x-admin-key header.",
      });
    }
    next();
  };
}

/**
 * In-memory per-IP rate limiter for admin routes (hosted only). Limits each
 * source IP to ADMIN_RATE_LIMIT_MAX admin requests per rolling minute. Closes
 * the unbounded-minting hole (point 4). Single-host guarantee; multi-host
 * deployments need a shared store (documented residual).
 */
export function adminRateLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const entry = adminIpWindows.get(ip);

  if (!entry || now - entry.windowStart > ADMIN_RATE_LIMIT_WINDOW_MS) {
    adminIpWindows.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > ADMIN_RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((ADMIN_RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return res.status(429).json({
      error: "Admin route rate limit exceeded.",
      code: "admin_rate_limited",
      retryAfter,
    });
  }

  next();
}

/**
 * Test seam: reset the in-memory admin IP windows between tests.
 */
export function resetAdminRateLimiterForTests() {
  adminIpWindows.clear();
}

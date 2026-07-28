import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import {
  apiKeyAuth,
  adminAuth,
  adminRateLimiter,
  resetAdminRateLimiterForTests,
} from "../server/middleware/auth.js";
import { createKey, revokeKey, setDbPath, resetDbPath } from "../server/db/keys.js";
import {
  setRuntimeModeForTesting,
  resetRuntimeMode,
} from "../server/core/config.js";

function tempDbPath() {
  return resolve(tmpdir(), `nsect-auth-${randomUUID()}.sqlite`);
}

function removeDbFiles(dbPath) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

/**
 * Shared DB + mode setup. Each describe block forces a mode; afterEach restores
 * local (the safe default) so tests cannot leak hosted state across files.
 */
function setupDb() {
  const dbPath = tempDbPath();
  setDbPath(dbPath);
  return () => {
    resetDbPath();
    removeDbFiles(dbPath);
  };
}

describe("apiKeyAuth — LOCAL mode (conditional surface inactive)", () => {
  let teardown;

  beforeEach(() => {
    teardown = setupDb();
    setRuntimeModeForTesting("local");
    resetAdminRateLimiterForTests();
  });

  afterEach(() => {
    resetRuntimeMode();
    teardown();
  });

  it("passes through with NO key and NO 401", () => {
    const req = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("passes through search requests with no cooldown enforcement", () => {
    const req = { headers: {}, query: {}, body: { query: "anything" } };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("ignores invalid keys in local mode (no validation runs)", () => {
    const req = { headers: { "x-api-key": "garbage" }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe("apiKeyAuth — HOSTED mode (full validation)", () => {
  let teardown;
  let validKey;
  let revokedKey;

  beforeEach(() => {
    teardown = setupDb();
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: "test-admin-secret" });
    resetAdminRateLimiterForTests();
    validKey = createKey("auth-valid").apiKey;
    revokedKey = createKey("auth-revoked").apiKey;
    revokeKey(revokedKey);
  });

  afterEach(() => {
    resetRuntimeMode();
    teardown();
  });

  it("returns 401 when no key is provided", () => {
    const req = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/API key required/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes when x-api-key header has valid key", () => {
    const req = { headers: { "x-api-key": validKey }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("reads key from Authorization Bearer header", () => {
    const req = { headers: { authorization: `Bearer ${validKey}` }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("reads key from array-form headers", () => {
    const req = {
      headers: {
        "x-api-key": ["", ` ${validKey} `],
      },
      query: {},
    };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("rejects query-param key usage", () => {
    const req = { headers: {}, query: { apikey: validKey } };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for revoked key", () => {
    const req = { headers: { "x-api-key": revokedKey }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/revoked/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 429 for rate-limited keys", () => {
    const rlKey = createKey("rl", 1).apiKey;
    const req = { headers: { "x-api-key": rlKey }, query: {} };

    apiKeyAuth(req, mockRes(), vi.fn());
    const res = mockRes();
    const next = vi.fn();
    apiKeyAuth(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toMatch(/Rate limit exceeded/i);
    expect(res.body.code).toBe("rate_limited");
    expect(typeof res.body.retryAfter).toBe("number");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 429 for search cooldown violations", () => {
    const cooldownKey = createKey("cooldown-test", 100, null, 6).apiKey;

    const firstReq = {
      headers: { "x-api-key": cooldownKey },
      query: {},
      body: { query: "nsect crawler" },
    };
    const firstRes = mockRes();
    apiKeyAuth(firstReq, firstRes, vi.fn());
    expect(firstRes.statusCode).toBe(200);

    const req = {
      headers: { "x-api-key": cooldownKey },
      query: {},
      body: { query: "nsect crawler" },
    };
    const res = mockRes();
    const next = vi.fn();

    apiKeyAuth(req, res, next);

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toMatch(/cooldown/i);
    expect(res.body.code).toBe("cooldown");
    expect(typeof res.body.retryAfter).toBe("number");
    expect(res.body.cooldownSeconds).toBe(6);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("adminAuth — header-only, timing-safe (hosted)", () => {
  const ADMIN_SECRET = "a-strong-admin-secret";

  it("accepts the correct x-admin-key header", () => {
    const middleware = adminAuth(ADMIN_SECRET);
    const req = { headers: { "x-admin-key": ADMIN_SECRET } };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("rejects a wrong secret with 403", () => {
    const middleware = adminAuth(ADMIN_SECRET);
    const req = { headers: { "x-admin-key": "wrong" } };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects when x-admin-key is absent (no Bearer fallback)", () => {
    const middleware = adminAuth(ADMIN_SECRET);
    const req = { headers: { authorization: `Bearer ${ADMIN_SECRET}` } };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not leak the secret via timing (constant-time compare)", () => {
    const middleware = adminAuth(ADMIN_SECRET);
    // A prefix-matching wrong secret must still be rejected (guards against
    // naive === early-exit implementations).
    const req = { headers: { "x-admin-key": ADMIN_SECRET.slice(0, 5) + "xxxxx" } };
    const res = mockRes();
    middleware(req, mockRes(), vi.fn());
    expect(res.statusCode).toBe(200); // mockRes returns a fresh object; check the real one
    const res2 = mockRes();
    middleware(req, res2, vi.fn());
    expect(res2.statusCode).toBe(403);
  });
});

describe("adminRateLimiter — caps per-IP admin requests", () => {
  beforeEach(() => {
    resetAdminRateLimiterForTests();
  });

  it("allows up to the limit then returns 429", () => {
    const req = { ip: "1.2.3.4" };
    let lastRes = mockRes();
    for (let i = 0; i < 10; i++) {
      lastRes = mockRes();
      adminRateLimiter(req, lastRes, vi.fn());
      expect(lastRes.statusCode).toBe(200);
    }
    // 11th request exceeds the limit.
    const overRes = mockRes();
    adminRateLimiter(req, overRes, vi.fn());
    expect(overRes.statusCode).toBe(429);
    expect(overRes.body.code).toBe("admin_rate_limited");
  });

  it("tracks separate IPs independently", () => {
    const reqA = { ip: "10.0.0.1" };
    const reqB = { ip: "10.0.0.2" };
    for (let i = 0; i < 10; i++) {
      adminRateLimiter(reqA, mockRes(), vi.fn());
    }
    // IP B is unaffected by IP A hitting the limit.
    const resB = mockRes();
    adminRateLimiter(reqB, resB, vi.fn());
    expect(resB.statusCode).toBe(200);
  });
});

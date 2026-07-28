import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { app, buildApp } from "../server/index.js";
import {
  createKey,
  revokeKey,
  setDbPath,
  resetDbPath,
} from "../server/db/keys.js";
import {
  setRuntimeModeForTesting,
  resetRuntimeMode,
} from "../server/core/config.js";
import { resetAdminRateLimiterForTests } from "../server/middleware/auth.js";

const ADMIN_KEY = "test-admin-secret-for-routes";
const itLive = process.env.LIVE_INTEGRATION === "1" ? it : it.skip;

function tempDbPath() {
  return resolve(tmpdir(), `nsect-routes-${randomUUID()}.sqlite`);
}

function removeDbFiles(dbPath) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

let dbPath;

beforeEach(() => {
  dbPath = tempDbPath();
  setDbPath(dbPath);
  resetAdminRateLimiterForTests();
});

afterEach(() => {
  resetDbPath();
  removeDbFiles(dbPath);
});

// ---------------------------------------------------------------------------
// Health surface — mode-independent liveness + mode-gated observability
// ---------------------------------------------------------------------------

describe("GET /health (liveness, always open)", () => {
  beforeEach(() => setRuntimeModeForTesting("local"));
  afterEach(() => resetRuntimeMode());

  it("returns 200 with minimal liveness payload", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("nsect");
    expect(res.body.version).toBe("1.0.0");
    expect(typeof res.body.uptime).toBe("number");
    // Liveness must NOT leak memory or observability detail.
    expect(res.body).not.toHaveProperty("memory");
    expect(res.body).not.toHaveProperty("observability");
  });
});

describe("GET /health/observability", () => {
  describe("LOCAL mode — open", () => {
    beforeEach(() => setRuntimeModeForTesting("local"));
    afterEach(() => resetRuntimeMode());

    it("returns 200 with the full observability snapshot", async () => {
      const res = await request(app).get("/health/observability");
      expect(res.status).toBe(200);
      expect(res.body.observability).toBeTruthy();
      expect(typeof res.body.observability.success).toBe("number");
      expect(typeof res.body.observability.p95).toBe("number");
    });
  });

  describe("HOSTED mode — admin-gated", () => {
    let hostedApp;
    beforeEach(() => {
      setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
      hostedApp = buildApp().app;
    });
    afterEach(() => resetRuntimeMode());

    it("returns 403 without admin key (no leak to unauthenticated callers)", async () => {
      const res = await request(hostedApp).get("/health/observability");
      expect(res.status).toBe(403);
    });

    it("returns 200 with correct admin key", async () => {
      const res = await request(hostedApp)
        .get("/health/observability")
        .set("x-admin-key", ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body.observability).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Admin key lifecycle — disabled locally, admin+IP-limited hosted
// ---------------------------------------------------------------------------

describe("POST /api/keys — LOCAL mode (disabled)", () => {
  beforeEach(() => setRuntimeModeForTesting("local"));
  afterEach(() => resetRuntimeMode());

  it("returns 404 for key creation (route disabled in local mode)", async () => {
    const res = await request(app)
      .post("/api/keys/create")
      .set("x-admin-key", "anything")
      .send({ label: "blocked" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/local mode/i);
  });
});

describe("POST /api/keys — HOSTED mode", () => {
  let hostedApp;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
  });
  afterEach(() => resetRuntimeMode());

  it("blocks access without admin key", async () => {
    const res = await request(hostedApp)
      .post("/api/keys/create")
      .send({ label: "blocked" });
    expect(res.status).toBe(403);
  });

  it("rejects Bearer-based admin auth (header-only now)", async () => {
    const res = await request(hostedApp)
      .post("/api/keys/create")
      .set("authorization", `Bearer ${ADMIN_KEY}`)
      .send({ label: "bearer-admin" });
    expect(res.status).toBe(403);
  });

  it("creates a key with valid admin key via x-admin-key header", async () => {
    const res = await request(hostedApp)
      .post("/api/keys/create")
      .set("x-admin-key", ADMIN_KEY)
      .send({ label: "test-create" });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^sk_/);
    expect(res.body.label).toBe("test-create");
    expect(res.body.active).toBe(true);
    // Plaintext returned once; listing shows only the masked hash.
    expect(res.body).toHaveProperty("keyHash");
  });

  it("creates key with custom rate limit and expiry", async () => {
    const res = await request(hostedApp)
      .post("/api/keys/create")
      .set("x-admin-key", ADMIN_KEY)
      .send({ label: "custom", rateLimit: 50, expiresIn: 3600, searchCooldownSeconds: 6 });
    expect(res.status).toBe(201);
    expect(res.body.rateLimit).toBe(50);
    expect(res.body.searchCooldownSeconds).toBe(6);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("lists all keys with masked hashes (never plaintext)", async () => {
    createKey("list-test-1");
    createKey("list-test-2");
    const res = await request(hostedApp)
      .get("/api/keys")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBeGreaterThanOrEqual(2);
    for (const k of res.body.keys) {
      expect(k.keyHash).toMatch(/^[0-9a-f]{12}…$/);
      expect(k).not.toHaveProperty("apiKey");
    }
  });
});

// ---------------------------------------------------------------------------
// Engine — free locally, fully gated hosted
// ---------------------------------------------------------------------------

describe("POST /api/engine — LOCAL mode (keyless, free)", () => {
  beforeEach(() => setRuntimeModeForTesting("local"));
  afterEach(() => resetRuntimeMode());

  it("accepts requests with NO api key (no 401)", async () => {
    const res = await request(app)
      .post("/api/engine")
      .send({ url: "https://example.com" });
    // No 401 — passes auth. (May 400/502 on validation/network; the point is
    // no auth gate fired.)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("rejects query-param api keys silently (still passes through)", async () => {
    const res = await request(app)
      .post("/api/engine?apikey=sk_whatever")
      .send({});
    expect(res.status).not.toBe(401);
  });
});

describe("POST /api/engine — HOSTED mode (key required)", () => {
  let hostedApp;
  let testKey;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
    testKey = createKey("engine-test").apiKey;
  });
  afterEach(() => resetRuntimeMode());

  it("returns 401 without API key", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .send({ url: "https://example.com" });
    expect(res.status).toBe(401);
  });

  it("returns 403 with invalid API key", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", "sk_invalid00000000000000000000000000")
      .send({ url: "https://example.com" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when no url or google provided", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url.*google/i);
  });

  it("returns 403 with revoked key", async () => {
    const { apiKey } = createKey("revoke-engine");
    revokeKey(apiKey);
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", apiKey)
      .send({ url: "https://example.com" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/revoked/i);
  });

  it("accepts API key via Authorization Bearer header", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("authorization", `Bearer ${testKey}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects query-param API keys", async () => {
    const res = await request(hostedApp)
      .post(`/api/engine?apikey=${testKey}`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed JSON body", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .set("Content-Type", "application/json")
      .send("{ malformed");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON/i);
  });

  itLive("returns 200 for valid engine request (live)", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({ url: "https://example.com", format: "text", timeout: 15 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.output).toBe("string");
    expect(res.body.meta.type).toBe("page");
  }, 30000);

  itLive("returns 200 for search fallback (live)", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({ query: "example test query", format: "text", googleCount: 3, timeout: 15 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.meta.type).toBe("search");
    expect(res.body.meta.engineOrder.at(-1)).toBe("google");
  }, 30000);
});

// ---------------------------------------------------------------------------
// YouTube transcript — free locally, gated hosted
// ---------------------------------------------------------------------------

describe("POST /api/youtube/transcript — LOCAL mode (keyless)", () => {
  beforeEach(() => setRuntimeModeForTesting("local"));
  afterEach(() => resetRuntimeMode());

  it("accepts requests with NO api key", async () => {
    const res = await request(app)
      .post("/api/youtube/transcript")
      .send({ videoId: "dQw4w9WgXcQ" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe("POST /api/youtube/transcript — HOSTED mode", () => {
  let hostedApp;
  let testKey;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
    testKey = createKey("youtube-transcript-test").apiKey;
  });
  afterEach(() => resetRuntimeMode());

  it("returns 401 without API key", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .send({ videoId: "dQw4w9WgXcQ" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when no video target is supplied", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("x-api-key", testKey)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("accepts API key via Authorization Bearer header", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("authorization", `Bearer ${testKey}`)
      .send({});
    expect(res.status).toBe(400);
  });

  itLive("returns 200 for valid transcript request (live)", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("x-api-key", testKey)
      .send({ videoId: "dQw4w9WgXcQ", format: "text", timeout: 20 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.output).toBe("string");
    expect(res.body.meta.type).toBe("youtube_transcript");
  }, 45000);
});

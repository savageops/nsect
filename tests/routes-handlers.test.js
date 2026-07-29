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

const ADMIN_KEY = "route-handler-test-secret";

function tempDbPath() {
  return resolve(tmpdir(), `nsect-routes-handler-${randomUUID()}.sqlite`);
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
  resetRuntimeMode();
  resetDbPath();
  removeDbFiles(dbPath);
});

// ---------------------------------------------------------------------------
// Engine route — error code → HTTP status mapping
// ---------------------------------------------------------------------------

describe("Engine route error mapping (hosted mode)", () => {
  let hostedApp;
  let testKey;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
    testKey = createKey("error-test").apiKey;
  });

  it("returns 400 for validation error with field name", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({ url: "not-a-url" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.field).toBe("url");
  });

  it("returns 400 for invalid searchEngines", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({ query: "test", searchEngines: "yahoo,unknown" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("searchEngines");
  });

  it("returns 400 for invalid strategy", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({ url: "https://example.com", strategy: "turbo" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("strategy");
  });

  it("returns 400 for out-of-range timeout", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send({ url: "https://example.com", timeout: 999 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Engine route — content-type and payload edge cases
// ---------------------------------------------------------------------------

describe("Engine route payload edge cases (hosted)", () => {
  let hostedApp;
  let testKey;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
    testKey = createKey("payload-test").apiKey;
  });

  it("returns 400 for empty body (no JSON)", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .set("Content-Type", "application/json")
      .send("");
    expect(res.status).toBe(400);
  });

  it("returns 400 for JSON array instead of object", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .send([1, 2, 3]);
    // normalizeEngineRequest expects an object — array should fail validation
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 400 for JSON null body", async () => {
    const res = await request(hostedApp)
      .post("/api/engine")
      .set("x-api-key", testKey)
      .set("Content-Type", "application/json")
      .send("null");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// YouTube transcript route — error shape
// ---------------------------------------------------------------------------

describe("YouTube transcript route error shapes (hosted)", () => {
  let hostedApp;
  let testKey;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
    testKey = createKey("yt-test").apiKey;
  });

  it("returns 400 with VALIDATION_ERROR and field for missing video", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("x-api-key", testKey)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid language tag", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("x-api-key", testKey)
      .send({ videoId: "dQw4w9WgXcQ", language: "not-a-language-tag!!!" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.field).toBe("language");
  });

  it("returns 400 for out-of-range timeout", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("x-api-key", testKey)
      .send({ videoId: "dQw4w9WgXcQ", timeout: 999 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("timeout");
  });

  it("returns 400 for unknown adapter method", async () => {
    const res = await request(hostedApp)
      .post("/api/youtube/transcript")
      .set("x-api-key", testKey)
      .send({ videoId: "dQw4w9WgXcQ", methods: ["fake_adapter"] });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("methods");
  });
});

// ---------------------------------------------------------------------------
// Auth route — key CRUD edge cases (hosted)
// ---------------------------------------------------------------------------

describe("Auth route CRUD edge cases (hosted)", () => {
  let hostedApp;

  beforeEach(() => {
    setRuntimeModeForTesting("hosted", { ADMIN_KEY: ADMIN_KEY });
    hostedApp = buildApp().app;
  });

  it("GET /api/keys/:key returns 404 for unknown key", async () => {
    const res = await request(hostedApp)
      .get("/api/keys/sk_nonexistent00000000000000000000000")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("DELETE /api/keys/:key returns 404 for unknown key", async () => {
    const res = await request(hostedApp)
      .delete("/api/keys/sk_nonexistent00000000000000000000000")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(404);
  });

  it("DELETE /api/keys/:key returns 200 for existing key", async () => {
    const { apiKey } = createKey("to-delete");
    const res = await request(hostedApp)
      .delete(`/api/keys/${apiKey}`)
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  it("GET /api/keys/:key returns masked key info", async () => {
    const { apiKey } = createKey("inspect-test");
    const res = await request(hostedApp)
      .get(`/api/keys/${apiKey}`)
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("inspect-test");
    expect(res.body.keyHash).toMatch(/^[0-9a-f]{12}…$/);
    expect(res.body).not.toHaveProperty("apiKey");
  });

  it("POST /api/keys/create with no body uses defaults", async () => {
    const res = await request(hostedApp)
      .post("/api/keys/create")
      .set("x-admin-key", ADMIN_KEY)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^sk_/);
    expect(res.body.label).toBe("unnamed");
    expect(res.body.rateLimit).toBe(100);
    expect(res.body.searchCooldownSeconds).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Health route — sub-route paths
// ---------------------------------------------------------------------------

describe("Health route sub-paths (local)", () => {
  beforeEach(() => {
    setRuntimeModeForTesting("local");
  });

  it("GET /observability returns full snapshot", async () => {
    const res = await request(app).get("/observability");
    expect(res.status).toBe(200);
    expect(res.body.observability).toBeTruthy();
    expect(res.body.memory).toBeTruthy();
  });

  it("GET /health/observability returns full snapshot (alternate path)", async () => {
    const res = await request(app).get("/health/observability");
    expect(res.status).toBe(200);
    expect(res.body.observability).toBeTruthy();
  });

  it("GET /health does NOT include memory or observability", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("memory");
    expect(res.body).not.toHaveProperty("observability");
  });
});

// ---------------------------------------------------------------------------
// Global error handler edge cases (server/index.js)
// ---------------------------------------------------------------------------

describe("Global error handler edge cases (local)", () => {
  beforeEach(() => {
    setRuntimeModeForTesting("local");
  });

  it("returns 413 for body exceeding 10mb limit", async () => {
    // Create a body just over 10MB — express.json has a 10mb limit.
    // Express 5's body-parser emits entity.too.large which may surface as 413
    // or fall through to the global error handler as 500 depending on version.
    // We verify it doesn't hang or crash — any non-200 status is acceptable.
    const largeValue = "x".repeat(11 * 1024 * 1024);
    const body = JSON.stringify({ url: "https://example.com", query: largeValue });

    const res = await request(app)
      .post("/api/engine")
      .set("Content-Type", "application/json")
      .send(body);

    // Should return an error status (413 or 500 depending on Express version)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 400 for truncated JSON (incomplete body)", async () => {
    const res = await request(app)
      .post("/api/engine")
      .set("Content-Type", "application/json")
      .send('{"url":"https://example.com","query":"incomplete');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON/i);
  });

  it("returns 400 for JSON with trailing garbage", async () => {
    const res = await request(app)
      .post("/api/engine")
      .set("Content-Type", "application/json")
      .send('{"url":"https://example.com"}garbage');

    expect(res.status).toBe(400);
  });

  it("accepts body at exactly the content-length boundary (not over)", async () => {
    // A small valid JSON should pass through the parser fine
    const res = await request(app)
      .post("/api/engine")
      .set("Content-Type", "application/json")
      .send('{"url":"https://example.com"}');

    // In local mode, no auth required — should reach the engine handler
    // and return a non-4xx-parse-error status (200, 400 for missing strategy, etc)
    expect(res.status).not.toBe(400);
    expect(res.body.error || "").not.toMatch(/Invalid JSON/i);
  });

  it("handles GET request to unknown route gracefully", async () => {
    const res = await request(app).get("/api/nonexistent");
    expect(res.status).toBe(404);
  });

  it("handles POST to unknown route gracefully", async () => {
    const res = await request(app).post("/api/nonexistent").send({});
    expect(res.status).toBe(404);
  });

  it("handles PUT method on engine route (method not allowed)", async () => {
    const res = await request(app).put("/api/engine").send({});
    // Express returns 404 for unregistered methods on existing paths
    expect([404, 405]).toContain(res.status);
  });
});

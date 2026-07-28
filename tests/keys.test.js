import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  validateKey,
  createKey,
  revokeKey,
  listKeys,
  getKeyInfo,
  setDbPath,
  resetDbPath,
} from "../server/db/keys.js";

function tempDbPath() {
  return resolve(tmpdir(), `nsect-keys-${randomUUID()}.sqlite`);
}

function removeDbFiles(dbPath) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/**
 * Open the on-disk SQLite directly (bypassing the keys module) to prove the
 * plaintext secret is never persisted — only its sha-256 hash.
 */
function rawRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM api_keys").all();
  } finally {
    db.close();
  }
}

describe("server/db/keys.js", () => {
  let dbPath;

  beforeEach(() => {
    dbPath = tempDbPath();
    setDbPath(dbPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDbPath();
    removeDbFiles(dbPath);
  });

  it("creates keys with expected defaults and a plaintext returned once", () => {
    const result = createKey("test-key");
    expect(result.apiKey).toMatch(/^sk_[0-9a-f]{32}$/);
    expect(result.label).toBe("test-key");
    expect(result.active).toBe(true);
    expect(result.rateLimit).toBe(100);
    expect(result.searchCooldownSeconds).toBe(6);
    expect(result.useCount).toBe(0);
    expect(result.createdAt).toBeTruthy();
    expect(result.lastUsed).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.keyHash).toMatch(/^[0-9a-f]{12}…$/);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("creates multiple unique keys", () => {
    const a = createKey("a");
    const b = createKey("b");
    expect(a.apiKey).not.toBe(b.apiKey);
  });

  it("never persists the plaintext secret — only the sha-256 hash", () => {
    const { apiKey } = createKey("secret-check");
    const expectedHash = createHash("sha256").update(apiKey).digest("hex");

    const rows = rawRows(dbPath);
    expect(rows.length).toBe(1);
    expect(rows[0].key_hash).toBe(expectedHash);

    // The plaintext must not appear anywhere in the stored row.
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(apiKey);
    // The plaintext column must not exist as a field.
    expect(rows[0]).not.toHaveProperty("api_key");
  });

  it("returns valid: false for missing key", () => {
    const result = validateKey(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing");
  });

  it("returns valid: false for unknown key", () => {
    const result = validateKey("sk_nonexistent00000000000000000000000");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("returns valid: false for revoked key", () => {
    const { apiKey } = createKey("to-revoke");
    revokeKey(apiKey);
    const result = validateKey(apiKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("returns valid: false for expired key and deactivates it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { apiKey } = createKey("expiring", 100, 1);
    vi.advanceTimersByTime(1_100);
    const result = validateKey(apiKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("increments useCount and sets lastUsed on valid validation", () => {
    const { apiKey } = createKey("counter");
    validateKey(apiKey);
    validateKey(apiKey);
    validateKey(apiKey);
    const info = getKeyInfo(apiKey);
    expect(info.useCount).toBe(3);
    expect(info.lastUsed).toBeTruthy();
  });

  it("blocks requests after rate limit is exceeded", () => {
    const { apiKey } = createKey("ratelimited", 3);
    expect(validateKey(apiKey).valid).toBe(true);
    expect(validateKey(apiKey).valid).toBe(true);
    expect(validateKey(apiKey).valid).toBe(true);
    const result = validateKey(apiKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("rate_limited");
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("resets rate-limit window after 60 seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { apiKey } = createKey("windowreset", 2);
    validateKey(apiKey);
    validateKey(apiKey);
    expect(validateKey(apiKey).valid).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(validateKey(apiKey).valid).toBe(true);
  });

  it("enforces search cooldown when enabled", () => {
    const { apiKey } = createKey("cooldown", 100, null, 6);
    expect(validateKey(apiKey, { enforceSearchCooldown: true }).valid).toBe(true);
    const result = validateKey(apiKey, { enforceSearchCooldown: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("cooldown");
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("lists keys with masked keyHash (never plaintext)", () => {
    createKey("list-a");
    createKey("list-b");
    const keys = listKeys();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const keyInfo of keys) {
      expect(keyInfo.keyHash).toMatch(/^[0-9a-f]{12}…$/);
      expect(keyInfo).not.toHaveProperty("apiKey");
    }
  });

  it("returns masked keyHash info for specific key", () => {
    const { apiKey } = createKey("info-test");
    const info = getKeyInfo(apiKey);
    expect(info).toBeTruthy();
    expect(info.label).toBe("info-test");
    expect(info.keyHash).toMatch(/^[0-9a-f]{12}…$/);
  });
});

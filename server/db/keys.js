/**
 * API-key lifecycle store backed by SQLite.
 *
 * Keys are stored ONLY as a sha-256 hash (key_hash). The plaintext `sk_…`
 * secret is returned exactly once at creation and never persisted — a database
 * file leak therefore cannot reveal usable credentials. Validation hashes the
 * incoming key and looks up the hash, so the plaintext never touches the query
 * path after creation.
 *
 * Clean-slate schema: the legacy keys.json migration bridge has been removed
 * (debt per doctrine item 6 — fallbacks are temporary, not permanent). The
 * api_keys table uses a hash primary key instead of the raw secret.
 *
 * All validation, rate-limit, and cooldown accounting runs inside a single
 * BEGIN IMMEDIATE transaction so concurrent requests on the same key cannot
 * race the counter updates.
 */

import Database from "better-sqlite3";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SEARCH_COOLDOWN_SECONDS } from "../core/contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, "..", "..", "data", "keys.sqlite");
const DEFAULT_RATE_LIMIT = 100;
const MAX_RATE_LIMIT = 10_000;
const MAX_SEARCH_COOLDOWN_SECONDS = 3600;
const RATE_LIMIT_WINDOW_MS = 60_000;

let _dbPath = DEFAULT_DB_PATH;
let _db = null;

/**
 * Hash a plaintext key into its storage form (sha-256, hex). Used both at
 * creation (to persist) and at validation (to look up). The hash is the
 * canonical identifier — the plaintext is never stored or queried.
 *
 * @param {string} apiKey
 * @returns {string}
 */
function hashKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Constant-time comparison between a presented secret and the configured admin
 * secret. Both inputs are sha-256 hashed first so the lengths align and the
 * comparison never leaks the plaintext length or content via timing.
 *
 * @param {string} presented
 * @param {string} expected
 * @returns {boolean}
 */
export function safeCompareSecret(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") {
    return false;
  }
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function closeDbIfOpen() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function ensureSchema(db) {
  // Clean-slate schema: key_hash is the primary key, not the raw secret.
  // If a table with the old plaintext `api_key` column exists (pre-hashing
  // schema), drop and recreate it — clean-slate migration per the remediation
  // decision. Local keys are ephemeral (data/ is gitignored), so this is safe.
  const tableInfo = db.prepare("PRAGMA table_info(api_keys)").all();
  if (tableInfo.length > 0) {
    const hasOldColumn = tableInfo.some((col) => col.name === "api_key");
    if (hasOldColumn) {
      db.exec("DROP TABLE IF EXISTS api_keys");
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      rate_limit INTEGER NOT NULL,
      search_cooldown_seconds INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used TEXT,
      expires_at INTEGER,
      expired_at TEXT,
      revoked_at TEXT,
      window_start INTEGER,
      window_count INTEGER NOT NULL DEFAULT 0,
      last_search_at INTEGER,
      last_search_at_iso TEXT
    );
  `);
}

function normalizeRateLimit(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_RATE_LIMIT) {
    return DEFAULT_RATE_LIMIT;
  }
  return numeric;
}

function normalizeExpiresInSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeSearchCooldownSeconds(value) {
  const numeric = Number(value);
  if (
    !Number.isInteger(numeric)
    || numeric < MIN_SEARCH_COOLDOWN_SECONDS
    || numeric > MAX_SEARCH_COOLDOWN_SECONDS
  ) {
    return MIN_SEARCH_COOLDOWN_SECONDS;
  }
  return numeric;
}

function getDb() {
  if (_db) return _db;

  const dbDir = dirname(_dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(_dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  ensureSchema(db);

  _db = db;
  return _db;
}

function withImmediateTransaction(fn) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw err;
  }
}

/**
 * Public-facing key identifier: a short prefix of the hash. The plaintext
 * secret is never exposed here — only enough of the hash to let an operator
 * distinguish keys in a list without revealing usable credential material.
 *
 * @param {string} keyHash
 * @returns {string}
 */
function maskKeyHash(keyHash) {
  return `${keyHash.substring(0, 12)}…`;
}

function mapRowToPublic(row) {
  if (!row) return null;
  return {
    keyHash: maskKeyHash(row.key_hash),
    label: row.label,
    active: row.active === 1,
    rateLimit: row.rate_limit,
    searchCooldownSeconds: row.search_cooldown_seconds,
    useCount: row.use_count,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    expiresAt: row.expires_at,
    expiredAt: row.expired_at,
    revokedAt: row.revoked_at,
    windowStart: row.window_start,
    windowCount: row.window_count,
    lastSearchAt: row.last_search_at,
    lastSearchAtIso: row.last_search_at_iso,
  };
}

export function setDbPath(path) {
  closeDbIfOpen();
  _dbPath = path;
}

export function resetDbPath() {
  closeDbIfOpen();
  _dbPath = DEFAULT_DB_PATH;
}

/**
 * Validate a presented plaintext API key. The key is hashed and looked up by
 * hash; the plaintext is never queried against the table. Enforces expiry,
 * search cooldown, and a rolling rate-limit window, all inside one transaction.
 *
 * @param {string} apiKey  Plaintext key as presented by the caller.
 * @param {{ enforceSearchCooldown?: boolean }} [options]
 * @returns {{ valid: true } | { valid: false, reason: string, retryAfter?: number, cooldownSeconds?: number }}
 */
export function validateKey(apiKey, { enforceSearchCooldown = false } = {}) {
  if (!apiKey) return { valid: false, reason: "missing" };
  const keyHash = hashKey(apiKey);

  return withImmediateTransaction((db) => {
    const selectStmt = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?");
    const updateStmt = db.prepare(`
      UPDATE api_keys
      SET
        active = @active,
        rate_limit = @rate_limit,
        search_cooldown_seconds = @search_cooldown_seconds,
        use_count = @use_count,
        last_used = @last_used,
        expires_at = @expires_at,
        expired_at = @expired_at,
        window_start = @window_start,
        window_count = @window_count,
        last_search_at = @last_search_at,
        last_search_at_iso = @last_search_at_iso
      WHERE key_hash = @key_hash
    `);

    const row = selectStmt.get(keyHash);
    if (!row) return { valid: false, reason: "not_found" };
    if (row.active !== 1) {
      // Distinguish lazy-deactivated-by-expiry from explicitly revoked.
      // Without this, a key that expired while idle returns "expired" on the
      // first call (when the expiry check fires) but "revoked" on every
      // subsequent call (because active=0) — inconsistent error semantics.
      return { valid: false, reason: row.expired_at ? "expired" : "revoked" };
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const normalizedRateLimit = normalizeRateLimit(row.rate_limit);
    const normalizedCooldown = normalizeSearchCooldownSeconds(row.search_cooldown_seconds);

    let active = row.active;
    let useCount = row.use_count || 0;
    let lastUsed = row.last_used || null;
    let expiresAt = row.expires_at || null;
    let expiredAt = row.expired_at || null;
    let windowStart = row.window_start || null;
    let windowCount = row.window_count || 0;
    let lastSearchAt = row.last_search_at || null;
    let lastSearchAtIso = row.last_search_at_iso || null;

    if (expiresAt && now > expiresAt) {
      active = 0;
      expiredAt = nowIso;
      updateStmt.run({
        key_hash: keyHash,
        active,
        rate_limit: normalizedRateLimit,
        search_cooldown_seconds: normalizedCooldown,
        use_count: useCount,
        last_used: lastUsed,
        expires_at: expiresAt,
        expired_at: expiredAt,
        window_start: windowStart,
        window_count: windowCount,
        last_search_at: lastSearchAt,
        last_search_at_iso: lastSearchAtIso,
      });
      return { valid: false, reason: "expired" };
    }

    if (enforceSearchCooldown && lastSearchAt) {
      const cooldownMs = normalizedCooldown * 1000;
      const elapsedSinceLastSearch = now - lastSearchAt;
      if (elapsedSinceLastSearch < cooldownMs) {
        return {
          valid: false,
          reason: "cooldown",
          retryAfter: Math.ceil((cooldownMs - elapsedSinceLastSearch) / 1000),
          cooldownSeconds: normalizedCooldown,
        };
      }
    }

    if (!windowStart || now - windowStart > RATE_LIMIT_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
    }

    windowCount += 1;
    if (windowCount > normalizedRateLimit) {
      return {
        valid: false,
        reason: "rate_limited",
        retryAfter: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - windowStart)) / 1000),
      };
    }

    useCount += 1;
    lastUsed = nowIso;
    if (enforceSearchCooldown) {
      lastSearchAt = now;
      lastSearchAtIso = nowIso;
    }

    updateStmt.run({
      key_hash: keyHash,
      active,
      rate_limit: normalizedRateLimit,
      search_cooldown_seconds: normalizedCooldown,
      use_count: useCount,
      last_used: lastUsed,
      expires_at: expiresAt,
      expired_at: expiredAt,
      window_start: windowStart,
      window_count: windowCount,
      last_search_at: lastSearchAt,
      last_search_at_iso: lastSearchAtIso,
    });

    return { valid: true };
  });
}

/**
 * Create a new API key. Generates a high-entropy plaintext secret, persists
 * only its hash, and returns the plaintext exactly once. The caller must
 * surface it to the operator immediately — it is unrecoverable afterwards.
 *
 * @param {string} [label]
 * @param {number} [rateLimit]
 * @param {number|null} [expiresInSeconds]
 * @param {number} [searchCooldownSeconds]
 * @returns {{ apiKey: string, keyHash: string, label: string, active: boolean, rateLimit: number, searchCooldownSeconds: number, useCount: number, createdAt: string, lastUsed: null, expiresAt: number|null, expiredAt: null, revokedAt: null, windowStart: null, windowCount: number, lastSearchAt: null, lastSearchAtIso: null }}
 */
export function createKey(
  label = "unnamed",
  rateLimit = DEFAULT_RATE_LIMIT,
  expiresInSeconds = null,
  searchCooldownSeconds = MIN_SEARCH_COOLDOWN_SECONDS,
) {
  const apiKey = `sk_${randomUUID().replace(/-/g, "")}`;
  const keyHash = hashKey(apiKey);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const normalizedRateLimit = normalizeRateLimit(rateLimit);
  const normalizedExpiresIn = normalizeExpiresInSeconds(expiresInSeconds);
  const normalizedCooldown = normalizeSearchCooldownSeconds(searchCooldownSeconds);

  withImmediateTransaction((db) => {
    const insert = db.prepare(`
      INSERT INTO api_keys (
        key_hash, label, active, rate_limit, search_cooldown_seconds,
        use_count, created_at, last_used, expires_at, expired_at, revoked_at,
        window_start, window_count, last_search_at, last_search_at_iso
      ) VALUES (
        @key_hash, @label, 1, @rate_limit, @search_cooldown_seconds,
        0, @created_at, NULL, @expires_at, NULL, NULL,
        NULL, 0, NULL, NULL
      )
    `);

    insert.run({
      key_hash: keyHash,
      label: String(label),
      rate_limit: normalizedRateLimit,
      search_cooldown_seconds: normalizedCooldown,
      created_at: nowIso,
      expires_at: normalizedExpiresIn ? now + normalizedExpiresIn * 1000 : null,
    });
  });

  return {
    apiKey,
    keyHash: maskKeyHash(keyHash),
    label: String(label),
    active: true,
    rateLimit: normalizedRateLimit,
    searchCooldownSeconds: normalizedCooldown,
    useCount: 0,
    createdAt: nowIso,
    lastUsed: null,
    expiresAt: normalizedExpiresIn ? now + normalizedExpiresIn * 1000 : null,
    expiredAt: null,
    revokedAt: null,
    windowStart: null,
    windowCount: 0,
    lastSearchAt: null,
    lastSearchAtIso: null,
  };
}

export function revokeKey(apiKey) {
  if (!apiKey) return false;
  const keyHash = hashKey(apiKey);
  return withImmediateTransaction((db) => {
    const row = db.prepare("SELECT key_hash FROM api_keys WHERE key_hash = ?").get(keyHash);
    if (!row) return false;
    db.prepare("UPDATE api_keys SET active = 0, revoked_at = ? WHERE key_hash = ?")
      .run(new Date().toISOString(), keyHash);
    return true;
  });
}

export function listKeys() {
  const rows = getDb()
    .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
    .all();
  return rows.map((row) => mapRowToPublic(row));
}

/**
 * Look up a key by its plaintext (hashed internally). Used by admin
 * inspect-by-key routes. Returns the masked public projection.
 *
 * @param {string} apiKey
 */
export function getKeyInfo(apiKey) {
  if (!apiKey) return null;
  const keyHash = hashKey(apiKey);
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash);
  return mapRowToPublic(row);
}

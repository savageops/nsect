use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use rand::distr::{Alphanumeric, SampleString};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Sha256, Digest};

use crate::contracts::MIN_SEARCH_COOLDOWN_SECONDS;

const DEFAULT_RATE_LIMIT: i64 = 100;
const MAX_RATE_LIMIT: i64 = 10_000;
const MAX_SEARCH_COOLDOWN_SECONDS: i64 = 3600;
const RATE_LIMIT_WINDOW_MS: i64 = 60_000;

/// Hash a plaintext API key into its storage form (sha-256, hex). Used both at
/// creation (to persist) and at validation (to look up). The hash is the
/// canonical identifier — the plaintext is never stored or queried.
pub fn hash_key(api_key: &str) -> String {
    let digest = Sha256::digest(api_key.as_bytes());
    hex::encode_hex(digest)
}

/// Constant-time comparison of a presented secret against the expected value.
/// Both are sha-256 hashed first so lengths align and timing cannot leak the
/// plaintext length or content.
pub fn safe_compare_secret(presented: &str, expected: &str) -> bool {
    use subtle::ConstantTimeEq;
    let a = Sha256::digest(presented.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.ct_eq(&b).into()
}

// Minimal inline hex encoder to avoid pulling a hex crate dependency.
mod hex {
    pub fn encode_hex(bytes: impl AsRef<[u8]>) -> String {
        let bytes = bytes.as_ref();
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }
}

#[derive(Clone)]
pub struct KeyStore {
    conn: Arc<Mutex<Connection>>,
}

/// A key record. At creation time `api_key` carries the plaintext secret
/// (returned once to the caller); in all persisted/queried contexts only the
/// `key_hash` is stored. The `key_hash` field is the masked hash prefix in
/// public listings.
#[derive(Debug, Clone, Serialize)]
pub struct KeyRecord {
    /// Plaintext secret — populated ONLY at creation, never persisted.
    #[serde(rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "keyHash")]
    pub key_hash: String,
    pub label: String,
    pub active: bool,
    #[serde(rename = "rateLimit")]
    pub rate_limit: i64,
    #[serde(rename = "searchCooldownSeconds")]
    pub search_cooldown_seconds: i64,
    #[serde(rename = "useCount")]
    pub use_count: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastUsed")]
    pub last_used: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<i64>,
    #[serde(rename = "expiredAt")]
    pub expired_at: Option<String>,
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<String>,
    #[serde(rename = "windowStart")]
    pub window_start: Option<i64>,
    #[serde(rename = "windowCount")]
    pub window_count: i64,
    #[serde(rename = "lastSearchAt")]
    pub last_search_at: Option<i64>,
    #[serde(rename = "lastSearchAtIso")]
    pub last_search_at_iso: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateKeyInput {
    pub label: Option<String>,
    pub rate_limit: Option<i64>,
    pub search_cooldown_seconds: Option<i64>,
    pub expires_in_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ValidationContext {
    pub enforce_search_cooldown: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationFailure {
    pub status: u16,
    pub error: String,
    pub code: String,
    #[serde(rename = "retryAfter", skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<i64>,
    #[serde(rename = "cooldownSeconds", skip_serializing_if = "Option::is_none")]
    pub cooldown_seconds: Option<i64>,
}

impl KeyStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("failed to create key database dir {}", parent.display())
            })?;
        }

        let conn = Connection::open(path)
            .with_context(|| format!("failed to open SQLite database {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        // Clean-slate migration: if the old plaintext `api_key` schema exists,
        // drop and recreate. Local keys are ephemeral (data/ is gitignored).
        {
            let mut stmt = conn.prepare("PRAGMA table_info(api_keys)")?;
            let has_old_column = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .filter_map(Result::ok)
                .any(|name| name == "api_key");
            if has_old_column {
                conn.execute_batch("DROP TABLE IF EXISTS api_keys")?;
            }
        }

        // Clean-slate schema: key_hash is the primary key, not the raw secret.
        conn.execute_batch(
            r#"
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
            "#,
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn create_key(&self, input: CreateKeyInput) -> Result<KeyRecord> {
        let api_key = generate_api_key();
        let key_hash = hash_key(&api_key);
        let label = input.label.unwrap_or_else(|| "unnamed".to_string());
        let rate_limit = normalize_rate_limit(input.rate_limit.unwrap_or(DEFAULT_RATE_LIMIT));
        let search_cooldown_seconds = normalize_search_cooldown(
            input
                .search_cooldown_seconds
                .unwrap_or(MIN_SEARCH_COOLDOWN_SECONDS),
        );
        let now = Utc::now();
        let expires_at = input
            .expires_in_seconds
            .map(|seconds| now.timestamp_millis() + (seconds * 1000));

        {
            let conn = self
                .conn
                .lock()
                .map_err(|_| anyhow!("key database mutex poisoned"))?;
            conn.execute(
                r#"
                INSERT INTO api_keys (
                  key_hash, label, active, rate_limit, search_cooldown_seconds,
                  use_count, created_at, last_used, expires_at, expired_at, revoked_at,
                  window_start, window_count, last_search_at, last_search_at_iso
                ) VALUES (?1, ?2, 1, ?3, ?4, 0, ?5, NULL, ?6, NULL, NULL, NULL, 0, NULL, NULL)
                "#,
                params![
                    key_hash,
                    label,
                    rate_limit,
                    search_cooldown_seconds,
                    now.to_rfc3339(),
                    expires_at
                ],
            )?;
        }

        // Re-read by hash (masked) and inject the plaintext into the returned
        // record so the caller sees it exactly once.
        let mut record = self
            .get_key_by_hash(&key_hash, true)?
            .ok_or_else(|| anyhow!("created key could not be re-read"))?;
        record.api_key = Some(api_key);
        Ok(record)
    }

    pub fn list_keys(&self) -> Result<Vec<KeyRecord>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("key database mutex poisoned"))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT key_hash, label, active, rate_limit, search_cooldown_seconds, use_count,
                   created_at, last_used, expires_at, expired_at, revoked_at,
                   window_start, window_count, last_search_at, last_search_at_iso
            FROM api_keys
            ORDER BY created_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], |row| map_row(row))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Look up a key by its plaintext (hashed internally). Used by admin
    /// inspect-by-key routes. Returns the masked-hash projection.
    pub fn get_key(&self, api_key: &str, _masked: bool) -> Result<Option<KeyRecord>> {
        let key_hash = hash_key(api_key);
        self.get_key_by_hash(&key_hash, true)
    }

    fn get_key_by_hash(&self, key_hash: &str, masked: bool) -> Result<Option<KeyRecord>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("key database mutex poisoned"))?;
        conn.query_row(
            r#"
            SELECT key_hash, label, active, rate_limit, search_cooldown_seconds, use_count,
                   created_at, last_used, expires_at, expired_at, revoked_at,
                   window_start, window_count, last_search_at, last_search_at_iso
            FROM api_keys
            WHERE key_hash = ?1
            "#,
            params![key_hash],
            |row| map_row(row),
        )
        .optional()
        .map(|opt| opt.map(|mut r| {
            if !masked {
                r.key_hash = key_hash.to_string();
            }
            r
        }))
        .map_err(Into::into)
    }

    pub fn revoke_key(&self, api_key: &str) -> Result<bool> {
        let key_hash = hash_key(api_key);
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow!("key database mutex poisoned"))?;
        let now = Utc::now().to_rfc3339();
        let changed = conn.execute(
            "UPDATE api_keys SET active = 0, revoked_at = ?2 WHERE key_hash = ?1",
            params![key_hash, now],
        )?;
        Ok(changed > 0)
    }

    /// Validate a presented plaintext key. The key is hashed and looked up by
    /// hash; the plaintext never touches the query path after creation.
    pub fn validate_key(
        &self,
        api_key: &str,
        context: ValidationContext,
    ) -> Result<(), ValidationFailure> {
        if api_key.trim().is_empty() {
            return Err(ValidationFailure {
                status: 401,
                error: "API key required via x-api-key or Authorization header.".to_string(),
                code: "auth_required".to_string(),
                retry_after: None,
                cooldown_seconds: None,
            });
        }
        let key_hash = hash_key(api_key);

        let conn = self.conn.lock().map_err(|_| ValidationFailure {
            status: 500,
            error: "Key database unavailable.".to_string(),
            code: "key_store_error".to_string(),
            retry_after: None,
            cooldown_seconds: None,
        })?;

        let tx = conn
            .unchecked_transaction()
            .map_err(|_| ValidationFailure {
                status: 500,
                error: "Key database unavailable.".to_string(),
                code: "key_store_error".to_string(),
                retry_after: None,
                cooldown_seconds: None,
            })?;

        let mut record = tx
            .query_row(
                r#"
                SELECT key_hash, label, active, rate_limit, search_cooldown_seconds, use_count,
                       created_at, last_used, expires_at, expired_at, revoked_at,
                       window_start, window_count, last_search_at, last_search_at_iso
                FROM api_keys
                WHERE key_hash = ?1
                "#,
                params![key_hash],
                |row| map_row(row),
            )
            .optional()
            .map_err(|_| ValidationFailure {
                status: 500,
                error: "Key database unavailable.".to_string(),
                code: "key_store_error".to_string(),
                retry_after: None,
                cooldown_seconds: None,
            })?
            .ok_or_else(|| ValidationFailure {
                status: 403,
                error: "Invalid API key.".to_string(),
                code: "invalid_key".to_string(),
                retry_after: None,
                cooldown_seconds: None,
            })?;

        if !record.active {
            return Err(ValidationFailure {
                status: 403,
                error: "API key has been revoked.".to_string(),
                code: "revoked".to_string(),
                retry_after: None,
                cooldown_seconds: None,
            });
        }

        let now_ms = Utc::now().timestamp_millis();
        let now_iso = Utc::now().to_rfc3339();

        if let Some(expires_at) = record.expires_at {
            if now_ms > expires_at {
                tx.execute(
                    "UPDATE api_keys SET active = 0, expired_at = ?2 WHERE key_hash = ?1",
                    params![key_hash, now_iso],
                )
                .map_err(|_| ValidationFailure {
                    status: 500,
                    error: "Key database unavailable.".to_string(),
                    code: "key_store_error".to_string(),
                    retry_after: None,
                    cooldown_seconds: None,
                })?;
                tx.commit().map_err(|_| ValidationFailure {
                    status: 500,
                    error: "Key database unavailable.".to_string(),
                    code: "key_store_error".to_string(),
                    retry_after: None,
                    cooldown_seconds: None,
                })?;
                return Err(ValidationFailure {
                    status: 403,
                    error: "API key has expired.".to_string(),
                    code: "expired".to_string(),
                    retry_after: None,
                    cooldown_seconds: None,
                });
            }
        }

        if context.enforce_search_cooldown {
            if let Some(last_search_at) = record.last_search_at {
                let cooldown_ms = record.search_cooldown_seconds * 1000;
                let elapsed = now_ms - last_search_at;
                if elapsed < cooldown_ms {
                    let retry_after = ((cooldown_ms - elapsed) + 999) / 1000;
                    return Err(ValidationFailure {
                        status: 429,
                        error: format!(
                            "Search cooldown active. Retry after {retry_after}s. Minimum {}s between search queries per API key.",
                            record.search_cooldown_seconds
                        ),
                        code: "cooldown".to_string(),
                        retry_after: Some(retry_after),
                        cooldown_seconds: Some(record.search_cooldown_seconds),
                    });
                }
            }
        }

        let mut window_start = record.window_start.unwrap_or(now_ms);
        let mut window_count = record.window_count;
        if now_ms - window_start > RATE_LIMIT_WINDOW_MS {
            window_start = now_ms;
            window_count = 0;
        }
        window_count += 1;

        if window_count > normalize_rate_limit(record.rate_limit) {
            return Err(ValidationFailure {
                status: 429,
                error: "Rate limit exceeded. Retry after 60s.".to_string(),
                code: "rate_limited".to_string(),
                retry_after: Some(60),
                cooldown_seconds: None,
            });
        }

        record.use_count += 1;
        record.last_used = Some(now_iso.clone());
        record.window_start = Some(window_start);
        record.window_count = window_count;
        if context.enforce_search_cooldown {
            record.last_search_at = Some(now_ms);
            record.last_search_at_iso = Some(now_iso.clone());
        }

        tx.execute(
            r#"
            UPDATE api_keys
            SET use_count = ?2,
                last_used = ?3,
                window_start = ?4,
                window_count = ?5,
                last_search_at = ?6,
                last_search_at_iso = ?7
            WHERE key_hash = ?1
            "#,
            params![
                key_hash,
                record.use_count,
                record.last_used,
                record.window_start,
                record.window_count,
                record.last_search_at,
                record.last_search_at_iso
            ],
        )
        .map_err(|_| ValidationFailure {
            status: 500,
            error: "Key database unavailable.".to_string(),
            code: "key_store_error".to_string(),
            retry_after: None,
            cooldown_seconds: None,
        })?;
        tx.commit().map_err(|_| ValidationFailure {
            status: 500,
            error: "Key database unavailable.".to_string(),
            code: "key_store_error".to_string(),
            retry_after: None,
            cooldown_seconds: None,
        })?;
        Ok(())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KeyRecord> {
    let key_hash: String = row.get(0)?;
    Ok(KeyRecord {
        api_key: None,
        key_hash: mask_key_hash(&key_hash),
        label: row.get(1)?,
        active: row.get::<_, i64>(2)? == 1,
        rate_limit: row.get(3)?,
        search_cooldown_seconds: row.get(4)?,
        use_count: row.get(5)?,
        created_at: row.get(6)?,
        last_used: row.get(7)?,
        expires_at: row.get(8)?,
        expired_at: row.get(9)?,
        revoked_at: row.get(10)?,
        window_start: row.get(11)?,
        window_count: row.get(12)?,
        last_search_at: row.get(13)?,
        last_search_at_iso: row.get(14)?,
    })
}

fn normalize_rate_limit(value: i64) -> i64 {
    value.clamp(1, MAX_RATE_LIMIT)
}

fn normalize_search_cooldown(value: i64) -> i64 {
    value.clamp(MIN_SEARCH_COOLDOWN_SECONDS, MAX_SEARCH_COOLDOWN_SECONDS)
}

/// Public-facing key identifier: a short prefix of the hash. The plaintext
/// secret is never exposed — only enough of the hash to let an operator
/// distinguish keys without revealing usable credential material.
fn mask_key_hash(value: &str) -> String {
    if value.len() <= 12 {
        format!("{value}…")
    } else {
        format!("{}…", &value[..12])
    }
}

fn generate_api_key() -> String {
    let mut rng = rand::rng();
    format!("sk_{}", Alphanumeric.sample_string(&mut rng, 32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_and_reads_key_with_hashed_storage() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.sqlite");
        let store = KeyStore::open(&path).unwrap();
        let created = store
            .create_key(CreateKeyInput {
                label: Some("test".to_string()),
                rate_limit: Some(10),
                search_cooldown_seconds: Some(6),
                expires_in_seconds: None,
            })
            .unwrap();

        // Plaintext returned once at creation.
        let plaintext = created.api_key.expect("plaintext at creation");
        assert!(plaintext.starts_with("sk_"));
        // The keyHash is the masked hash, not the plaintext.
        assert!(created.key_hash.ends_with('…'));
        assert!(!created.key_hash.starts_with("sk_"));

        // Validation via the plaintext works (hashes internally).
        store
            .validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false })
            .expect("valid key validates");
    }

    #[test]
    fn hash_key_is_deterministic() {
        let h1 = hash_key("sk_test123");
        let h2 = hash_key("sk_test123");
        assert_eq!(h1, h2);
        assert_ne!(h1, hash_key("sk_different"));
    }

    #[test]
    fn safe_compare_secret_is_constant_time() {
        assert!(safe_compare_secret("secret", "secret"));
        assert!(!safe_compare_secret("secret", "wrong"));
        assert!(!safe_compare_secret("", "secret"));
    }

    #[test]
    fn revoked_key_is_rejected() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let created = store
            .create_key(CreateKeyInput { label: None, rate_limit: None, search_cooldown_seconds: None, expires_in_seconds: None })
            .unwrap();
        let plaintext = created.api_key.unwrap();
        store.revoke_key(&plaintext).unwrap();
        let result = store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false });
        assert!(result.is_err());
        let fail = result.unwrap_err();
        assert_eq!(fail.code, "revoked");
    }

    #[test]
    fn rate_limit_blocks_after_exceeding() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let created = store
            .create_key(CreateKeyInput {
                label: Some("rl-test".to_string()),
                rate_limit: Some(2),
                search_cooldown_seconds: Some(6),
                expires_in_seconds: None,
            })
            .unwrap();
        let plaintext = created.api_key.unwrap();

        assert!(store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).is_ok());
        assert!(store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).is_ok());
        let result = store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "rate_limited");
    }

    #[test]
    fn search_cooldown_enforced_when_enabled() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let created = store
            .create_key(CreateKeyInput {
                label: Some("cd-test".to_string()),
                rate_limit: Some(100),
                search_cooldown_seconds: Some(6),
                expires_in_seconds: None,
            })
            .unwrap();
        let plaintext = created.api_key.unwrap();

        // First search validates
        assert!(store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: true }).is_ok());
        // Immediate second search is blocked
        let result = store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: true });
        assert!(result.is_err());
        let fail = result.unwrap_err();
        assert_eq!(fail.code, "cooldown");
        assert!(fail.retry_after.is_some());
        assert!(fail.cooldown_seconds.is_some());
    }

    #[test]
    fn search_cooldown_not_enforced_when_disabled() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let created = store
            .create_key(CreateKeyInput {
                label: Some("no-cd".to_string()),
                rate_limit: Some(100),
                search_cooldown_seconds: Some(6),
                expires_in_seconds: None,
            })
            .unwrap();
        let plaintext = created.api_key.unwrap();

        // Multiple validations with cooldown disabled should all pass
        assert!(store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).is_ok());
        assert!(store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).is_ok());
        assert!(store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).is_ok());
    }

    #[test]
    fn empty_key_rejected() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let result = store.validate_key("", ValidationContext { enforce_search_cooldown: false });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "auth_required");
    }

    #[test]
    fn whitespace_only_key_rejected() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let result = store.validate_key("   ", ValidationContext { enforce_search_cooldown: false });
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "auth_required");
    }

    #[test]
    fn unknown_key_rejected() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let result = store.validate_key(
            "sk_nonexistent00000000000000000000000",
            ValidationContext { enforce_search_cooldown: false },
        );
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "invalid_key");
    }

    #[test]
    fn list_keys_returns_masked_hashes() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        store
            .create_key(CreateKeyInput {
                label: Some("a".to_string()),
                rate_limit: None,
                search_cooldown_seconds: None,
                expires_in_seconds: None,
            })
            .unwrap();
        store
            .create_key(CreateKeyInput {
                label: Some("b".to_string()),
                rate_limit: None,
                search_cooldown_seconds: None,
                expires_in_seconds: None,
            })
            .unwrap();
        let keys = store.list_keys().unwrap();
        assert_eq!(keys.len(), 2);
        for key in &keys {
            assert!(key.key_hash.ends_with('…'));
            assert!(key.api_key.is_none()); // never plaintext
        }
    }

    #[test]
    fn get_key_returns_none_for_unknown() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let result = store.get_key("sk_nonexistent00000000000000000000000", true).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn revoke_unknown_key_returns_false() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let result = store.revoke_key("sk_nonexistent00000000000000000000000").unwrap();
        assert!(!result);
    }

    #[test]
    fn use_count_increments_on_validation() {
        let dir = tempdir().unwrap();
        let store = KeyStore::open(&dir.path().join("k.sqlite")).unwrap();
        let created = store
            .create_key(CreateKeyInput {
                label: Some("count".to_string()),
                rate_limit: Some(100),
                search_cooldown_seconds: Some(6),
                expires_in_seconds: None,
            })
            .unwrap();
        let plaintext = created.api_key.unwrap();

        store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).unwrap();
        store.validate_key(&plaintext, ValidationContext { enforce_search_cooldown: false }).unwrap();

        let info = store.get_key(&plaintext, true).unwrap().unwrap();
        assert_eq!(info.use_count, 2);
    }

    #[test]
    fn hash_key_never_stored_as_plaintext() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.sqlite");
        let store = KeyStore::open(&path).unwrap();
        let created = store
            .create_key(CreateKeyInput {
                label: Some("check".to_string()),
                rate_limit: None,
                search_cooldown_seconds: None,
                expires_in_seconds: None,
            })
            .unwrap();
        let plaintext = created.api_key.unwrap();

        // Open the DB raw and verify the plaintext doesn't appear
        let conn = rusqlite::Connection::open(&path).unwrap();
        let rows: Vec<String> = conn
            .prepare("SELECT key_hash FROM api_keys")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 1);
        assert_ne!(rows[0], plaintext);
        assert_eq!(rows[0], hash_key(&plaintext));
    }
}

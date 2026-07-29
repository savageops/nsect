use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use serde_json::json;

use crate::{
    AppState,
    config::Mode,
    db::{ValidationContext, safe_compare_secret},
};

/// Admin authentication gate for /api/keys/* routes (hosted mode only).
///
/// Validates the admin secret via a constant-time comparison (point 2) against
/// the configured ADMIN_KEY. Header-only (`x-admin-key`) — no Bearer ambiguity
/// with API keys (point 11c).
pub async fn admin_key_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let admin_key = state.config.admin_key.clone().unwrap_or_default();
    let presented = read_admin_key(request.headers()).unwrap_or_default();
    if !safe_compare_secret(&presented, &admin_key) {
        return json_error(
            StatusCode::FORBIDDEN.as_u16(),
            json!({ "error": "Admin key required via x-admin-key header." }),
        );
    }
    next.run(request).await
}

/// Authorize an API key for engine/transcript routes.
///
/// In Local mode this is a no-op (no validation, no rate limit, no cooldown) —
/// the developer's machine is the trust boundary. In Hosted mode it enforces
/// the full key-state validation. Returns Ok(()) on success or an error
/// Response on failure.
pub fn authorize_api_key(
    headers: &HeaderMap,
    state: &Arc<AppState>,
    enforce_search_cooldown: bool,
) -> Result<(), Response> {
    // Local mode: conditional security surface is inactive.
    if state.config.mode == Mode::Local {
        return Ok(());
    }

    let api_key = read_api_key(headers).unwrap_or_default();
    state
        .keys
        .validate_key(
            &api_key,
            ValidationContext {
                enforce_search_cooldown,
            },
        )
        .map_err(validation_failure_response)
}

pub fn read_api_key(headers: &HeaderMap) -> Option<String> {
    first_header_value(headers, "x-api-key").or_else(|| read_bearer_token(headers))
}

/// Admin key reader — header-only (`x-admin-key`). No Bearer fallback (point 11c).
/// Public so the observability health route can reuse it without duplicating
/// the header-parsing logic.
pub fn read_admin_key(headers: &HeaderMap) -> Option<String> {
    first_header_value(headers, "x-admin-key")
}

fn first_header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_bearer_token(headers: &HeaderMap) -> Option<String> {
    let authorization = headers.get("authorization")?.to_str().ok()?.trim();
    let prefix = authorization.get(..7)?;
    if !prefix.eq_ignore_ascii_case("bearer ") {
        return None;
    }
    let token = authorization[7..].trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub fn json_error(status: u16, body: serde_json::Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(Json(body).0.to_string()))
        .unwrap()
}

pub fn validation_failure_response(failure: crate::db::ValidationFailure) -> Response {
    let mut body = json!({
        "error": failure.error,
        "code": failure.code,
        "retryAfter": failure.retry_after,
    });
    if let Some(cooldown_seconds) = failure.cooldown_seconds {
        body["cooldownSeconds"] = json!(cooldown_seconds);
    }
    json_error(failure.status, body)
}

// -------------------------------------------------------------------------
// Per-IP admin rate limiter (hosted only). Closes the unbounded key-minting
// hole (point 4). In-memory and process-local — single-host guarantee;
// multi-host deployments need a shared store (documented residual).
// -------------------------------------------------------------------------

const ADMIN_RATE_LIMIT_WINDOW_MS: u128 = 60_000;
const ADMIN_RATE_LIMIT_MAX: u32 = 10;

/// Shared admin-rate-limit state. Keyed by source IP.
static ADMIN_WINDOWS: std::sync::LazyLock<Mutex<std::collections::HashMap<String, AdminWindow>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(Clone)]
struct AdminWindow {
    window_start: Instant,
    count: u32,
}

/// Check the per-IP admin rate limit. Returns true if allowed, false if the
/// caller exceeded ADMIN_RATE_LIMIT_MAX within the rolling window.
pub fn admin_rate_limit_allows(ip: &str) -> bool {
    let now = Instant::now();
    let mut windows = ADMIN_WINDOWS.lock().expect("admin rate limit mutex poisoned");
    match windows.get_mut(ip) {
        Some(entry) if now.duration_since(entry.window_start).as_millis() <= ADMIN_RATE_LIMIT_WINDOW_MS => {
            entry.count += 1;
            entry.count <= ADMIN_RATE_LIMIT_MAX
        }
        _ => {
            windows.insert(ip.to_string(), AdminWindow { window_start: now, count: 1 });
            true
        }
    }
}

/// Test seam: reset the admin IP windows.
pub fn reset_admin_rate_limit_for_tests() {
    ADMIN_WINDOWS.lock().expect("admin rate limit mutex poisoned").clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn make_headers(key: &str, value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        // HeaderMap requires 'static keys — use unwrap_or_default for safety
        if let Ok(name) = axum::http::HeaderName::from_bytes(key.as_bytes()) {
            h.insert(name, value.parse().unwrap());
        }
        h
    }

    // --- read_api_key ---

    #[test]
    fn read_api_key_from_x_api_key() {
        let h = make_headers("x-api-key", "sk_test123");
        assert_eq!(read_api_key(&h), Some("sk_test123".to_string()));
    }

    #[test]
    fn read_api_key_from_bearer() {
        let h = make_headers("authorization", "Bearer sk_from_bearer");
        assert_eq!(read_api_key(&h), Some("sk_from_bearer".to_string()));
    }

    #[test]
    fn read_api_key_lowercase_bearer() {
        let h = make_headers("authorization", "bearer sk_lower");
        assert_eq!(read_api_key(&h), Some("sk_lower".to_string()));
    }

    #[test]
    fn read_api_key_returns_none_when_missing() {
        let h = HeaderMap::new();
        assert_eq!(read_api_key(&h), None);
    }

    #[test]
    fn read_api_key_returns_none_for_empty_bearer() {
        let h = make_headers("authorization", "Bearer ");
        assert_eq!(read_api_key(&h), None);
    }

    #[test]
    fn read_api_key_returns_none_for_non_bearer_auth() {
        let h = make_headers("authorization", "Basic dXNlcjpwYXNz");
        assert_eq!(read_api_key(&h), None);
    }

    // --- read_admin_key ---

    #[test]
    fn read_admin_key_from_x_admin_key() {
        let h = make_headers("x-admin-key", "admin-secret");
        assert_eq!(read_admin_key(&h), Some("admin-secret".to_string()));
    }

    #[test]
    fn read_admin_key_returns_none_when_missing() {
        let h = HeaderMap::new();
        assert_eq!(read_admin_key(&h), None);
    }

    #[test]
    fn read_admin_key_does_not_read_bearer() {
        let h = make_headers("authorization", "Bearer admin-secret");
        assert_eq!(read_admin_key(&h), None);
    }

    #[test]
    fn read_admin_key_returns_none_for_empty() {
        let h = make_headers("x-admin-key", "");
        assert_eq!(read_admin_key(&h), None);
    }

    #[test]
    fn read_admin_key_trims_whitespace() {
        let h = make_headers("x-admin-key", "  trimmed-key  ");
        assert_eq!(read_admin_key(&h), Some("trimmed-key".to_string()));
    }

    // --- safe_compare_secret (via db module) ---

    #[test]
    fn safe_compare_secret_matches() {
        assert!(crate::db::safe_compare_secret("secret", "secret"));
    }

    #[test]
    fn safe_compare_secret_mismatch() {
        assert!(!crate::db::safe_compare_secret("secret", "wrong"));
    }

    #[test]
    fn safe_compare_secret_empty_inputs() {
        assert!(!crate::db::safe_compare_secret("", "secret"));
        assert!(!crate::db::safe_compare_secret("secret", ""));
        assert!(crate::db::safe_compare_secret("", ""));
    }

    // --- admin_rate_limit_allows ---

    #[test]
    fn rate_limit_allows_up_to_max() {
        reset_admin_rate_limit_for_tests();
        for _ in 0..10 {
            assert!(admin_rate_limit_allows("1.2.3.4"));
        }
    }

    #[test]
    fn rate_limit_blocks_after_max() {
        reset_admin_rate_limit_for_tests();
        for _ in 0..10 {
            admin_rate_limit_allows("5.6.7.8");
        }
        assert!(!admin_rate_limit_allows("5.6.7.8"));
    }

    #[test]
    fn rate_limit_tracks_ips_independently() {
        reset_admin_rate_limit_for_tests();
        for _ in 0..10 {
            admin_rate_limit_allows("10.0.0.1");
        }
        // IP B is unaffected
        assert!(admin_rate_limit_allows("10.0.0.2"));
    }

    #[test]
    fn rate_limit_handles_ipv6() {
        reset_admin_rate_limit_for_tests();
        for _ in 0..10 {
            admin_rate_limit_allows("::1");
        }
        assert!(!admin_rate_limit_allows("::1"));
        // IPv4 is separate
        assert!(admin_rate_limit_allows("127.0.0.1"));
    }

    #[test]
    fn rate_limit_handles_unknown_ip() {
        reset_admin_rate_limit_for_tests();
        assert!(admin_rate_limit_allows("unknown"));
    }

    // --- is_solver_eligible parity ---

    #[test]
    fn solver_eligible_kinds() {
        assert!(crate::solver::is_solver_eligible("cloudflare_turnstile"));
        assert!(crate::solver::is_solver_eligible("hcaptcha"));
        assert!(!crate::solver::is_solver_eligible("perimeterx"));
        assert!(!crate::solver::is_solver_eligible("blocked"));
    }
}

use std::{sync::Arc, time::Instant};

use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Request, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;

use crate::{
    AppState, auth,
    config::Mode,
    contracts::{ENGINE_API_PATH, OBSERVABILITY_PATH, SERVICE_NAME, YOUTUBE_TRANSCRIPT_API_PATH},
    db::{CreateKeyInput, KeyRecord},
    engine::run_nsect_engine,
    observability::{get_snapshot, record_engine_outcome, record_http_response, uptime_seconds},
    request::{
        EngineNormalizationOptions, EngineRequestInput, normalize_engine_request,
        request_validation_to_http,
    },
    transcript::{TranscriptInput, TranscriptValidationError, fetch_youtube_transcript},
};

pub fn build_router(state: Arc<AppState>) -> Router {
    let api_routes = Router::new()
        .route(ENGINE_API_PATH, post(engine))
        .route(YOUTUBE_TRANSCRIPT_API_PATH, post(youtube_transcript));

    let base = Router::new()
        .route("/health", get(health))
        .route("/health/observability", get(health_observability))
        .route(OBSERVABILITY_PATH, get(health_observability))
        .merge(api_routes);

    // Admin key-lifecycle routes: only mounted in hosted mode.
    let base = if state.config.mode == Mode::Hosted {
        let admin_routes = Router::new()
            .route("/api/keys/create", post(create_key))
            .route("/api/keys", get(list_keys))
            .route("/api/keys/{key}", get(inspect_key).delete(revoke_key))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                auth::admin_key_middleware,
            ))
            .layer(middleware::from_fn(admin_ip_limiter));
        base.merge(admin_routes)
    } else {
        // Local mode: key management is irrelevant. Honest 404, not a silent gate.
        base.route("/api/keys/{*rest}", get(local_mode_admin_disabled).post(local_mode_admin_disabled).delete(local_mode_admin_disabled))
    };

    base.with_state(state)
        .layer(middleware::from_fn(track_request_metrics))
}

async fn local_mode_admin_disabled() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "Key management is unavailable in local mode. Start in hosted mode (NSECT_HOSTED=1) to manage API keys."
        })),
    )
}

async fn track_request_metrics(request: Request, next: Next) -> Response {
    let started_at = Instant::now();
    let response = next.run(request).await;
    record_http_response(
        response.status().as_u16(),
        started_at.elapsed().as_secs_f64() * 1000.0,
    );
    response
}

/// Liveness: always open, minimal payload — no memory/observability leak.
async fn health() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": SERVICE_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime": uptime_seconds(),
    }))
}

/// Detailed observability snapshot. Authorization is enforced inside the
/// handler based on mode (hosted = admin-gated, local = open).
async fn health_observability(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if state.config.mode == Mode::Hosted {
        let admin_key = state.config.admin_key.clone().unwrap_or_default();
        let presented = auth::read_admin_key(&headers).unwrap_or_default();
        if !safe_compare_secret_wrapper(&presented, &admin_key) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "Admin key required via x-admin-key header." })),
            )
                .into_response();
        }
    }
    Json(json!({
        "status": "ok",
        "service": SERVICE_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime": uptime_seconds(),
        "memory": get_memory(),
        "observability": get_snapshot(),
    }))
    .into_response()
}

fn safe_compare_secret_wrapper(presented: &str, expected: &str) -> bool {
    crate::db::safe_compare_secret(presented, expected)
}

fn get_memory() -> serde_json::Value {
    // Lightweight process memory snapshot; avoids depending on a sysinfo crate.
    json!({
        "rss_hint": "see /health/observability on the host for full memory detail",
    })
}

/// Per-IP admin route rate limiter (hosted only). Closes the unbounded
/// key-minting hole (point 4). In-memory, single-host.
async fn admin_ip_limiter(request: Request, next: Next) -> Response {
    let ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    if !auth::admin_rate_limit_allows(&ip) {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "error": "Admin route rate limit exceeded.",
                    "code": "admin_rate_limited",
                })
                .to_string(),
            ))
            .unwrap();
    }
    next.run(request).await
}

// Use axum's Body import explicitly for the manual response builders.
use axum::body::Body;

async fn engine(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<EngineRequestInput>, JsonRejection>,
) -> impl IntoResponse {
    let payload = match payload {
        Ok(Json(payload)) => payload,
        Err(error) => return invalid_json_response(error),
    };

    let enforce_search_cooldown = payload
        .query
        .as_deref()
        .or(payload.google.as_deref())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    if let Err(response) = auth::authorize_api_key(&headers, &state, enforce_search_cooldown) {
        return response;
    }

    let mut params = match normalize_engine_request(
        payload,
        EngineNormalizationOptions {
            allow_file_output: false,
            allow_headful: false,
        },
    ) {
        Ok(params) => params,
        Err(error) => {
            let (status, body) = request_validation_to_http(&error);
            return auth::json_error(status, body);
        }
    };

    // Thread the solver config from AppState into the engine params so the
    // challenge-blocked branch can attempt interactive challenge solving.
    params.solver_config = Some(state.config.solver.clone());

    let result = run_nsect_engine(params).await;
    if !result.success {
        let status = match result.error_code.as_deref() {
            Some("BROWSER_LAUNCH") => StatusCode::SERVICE_UNAVAILABLE,
            Some("UPSTREAM_REQUEST") => StatusCode::BAD_GATEWAY,
            Some("CHALLENGE_BLOCKED") => StatusCode::BAD_GATEWAY,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        return (
            status,
            Json(json!({
                "error": result.error,
                "code": result.error_code.unwrap_or_else(|| "ENGINE_ERROR".to_string()),
            })),
        )
            .into_response();
    }

    record_engine_outcome(&result);
    Json(result).into_response()
}

async fn youtube_transcript(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<TranscriptInput>, JsonRejection>,
) -> impl IntoResponse {
    let payload = match payload {
        Ok(Json(payload)) => payload,
        Err(error) => return invalid_json_response(error),
    };

    if let Err(response) = auth::authorize_api_key(&headers, &state, false) {
        return response;
    }

    match fetch_youtube_transcript(payload, state).await {
        Ok(result) => (StatusCode::OK, Json(json!(result))).into_response(),
        Err(TranscriptValidationError { message, field }) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": message,
                "code": "VALIDATION_ERROR",
                "field": field,
            })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct CreateKeyBody {
    label: Option<String>,
    #[serde(rename = "rateLimit")]
    rate_limit: Option<i64>,
    #[serde(rename = "searchCooldownSeconds")]
    search_cooldown_seconds: Option<i64>,
    #[serde(rename = "expiresIn")]
    expires_in: Option<i64>,
}

#[derive(Debug, Serialize)]
struct KeyListResponse {
    keys: Vec<KeyRecord>,
}

async fn create_key(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateKeyBody>,
) -> impl IntoResponse {
    match state.keys.create_key(CreateKeyInput {
        label: body.label,
        rate_limit: body.rate_limit,
        search_cooldown_seconds: body.search_cooldown_seconds,
        expires_in_seconds: body.expires_in,
    }) {
        Ok(record) => (StatusCode::CREATED, Json(json!(record))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn list_keys(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.keys.list_keys() {
        Ok(keys) => (StatusCode::OK, Json(json!(KeyListResponse { keys }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn inspect_key(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    match state.keys.get_key(&key, true) {
        Ok(Some(record)) => (StatusCode::OK, Json(json!(record))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "API key not found." })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn revoke_key(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    match state.keys.revoke_key(&key) {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({
                "revokedAt": Utc::now().to_rfc3339(),
            })),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "API key not found." })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

fn invalid_json_response(error: JsonRejection) -> Response {
    let message = if matches!(error, JsonRejection::JsonSyntaxError(_)) {
        "Invalid JSON request body.".to_string()
    } else {
        error.body_text()
    };
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": message,
        })),
    )
        .into_response()
}

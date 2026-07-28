pub const ENGINE_API_PATH: &str = "/api/engine";
pub const YOUTUBE_TRANSCRIPT_API_PATH: &str = "/api/youtube/transcript";
pub const MIN_SEARCH_COOLDOWN_SECONDS: i64 = 6;
pub const SERVICE_NAME: &str = "nsect";

/// Health surface split: liveness is always open; the detailed observability
/// snapshot is gated by mode/admin so it cannot leak internal metrics to
/// unauthenticated callers in hosted deployments.
pub const OBSERVABILITY_PATH: &str = "/observability";

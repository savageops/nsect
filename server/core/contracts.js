export const SERVICE_NAME = "nsect";
export const SERVICE_VERSION = "1.0.0";

export const ENGINE_API_PATH = "/api/engine";
export const YOUTUBE_TRANSCRIPT_API_PATH = "/api/youtube/transcript";
export const MIN_SEARCH_COOLDOWN_SECONDS = 6;

// Health surface split: liveness is always open; the detailed observability
// snapshot is gated by mode/admin so it cannot leak internal metrics to
// unauthenticated callers in hosted deployments (point 5).
export const HEALTH_PATH = "/health";
export const OBSERVABILITY_PATH = "/observability";

/**
 * Express composition root.
 *
 * Wires routes against the runtime config owner. Mode-dependent behavior:
 *  - local:  engine + transcript run ungated; /api/keys disabled; /health and
 *            /health/observability both open (operator's own machine).
 *  - hosted: engine + transcript require a valid API key (rate limit + cooldown);
 *            /api/keys require timing-safe admin auth + per-IP limiter;
 *            /health is open liveness, /health/observability requires admin.
 *
 * Fail-fast: the config owner throws at getRuntimeConfig() time if hosted mode
 * has no ADMIN_KEY, so a keyless prod deploy cannot start.
 */

import express from "express";
import { apiKeyAuth, adminAuth, adminRateLimiter } from "./middleware/auth.js";
import engineRouter from "./routes/engine.js";
import youtubeTranscriptRouter from "./routes/youtube-transcript.js";
import authRouter from "./routes/auth.js";
import { livenessRouter, observabilityRouter } from "./routes/health.js";
import {
  ENGINE_API_PATH,
  YOUTUBE_TRANSCRIPT_API_PATH,
  HEALTH_PATH,
  OBSERVABILITY_PATH,
  SERVICE_NAME,
  SERVICE_VERSION,
} from "./core/contracts.js";
import { getRuntimeConfig, ensureDataDir } from "./core/config.js";
import { logError, logEvent } from "./observability/logging.js";
import { recordHttpResponse } from "./observability/metrics.js";

function composeApp() {
  const config = getRuntimeConfig();
  const { hosted, adminKey } = config;

  ensureDataDir();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Per-request timing + logging middleware (both modes).
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const rawPath = req.originalUrl || req.url || "/";
    const sanitizedPath = rawPath.split("?")[0];
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      recordHttpResponse({ statusCode: res.statusCode, durationMs });
      logEvent("http.request", {
        method: req.method,
        path: sanitizedPath,
        status: res.statusCode,
        duration_ms: durationMs,
      });
    });
    next();
  });

  // --- Health liveness: always open, minimal payload ---
  app.use(HEALTH_PATH, livenessRouter);

  // --- Observability: open locally, admin-gated in hosted mode (point 5) ---
  if (hosted) {
    app.use(OBSERVABILITY_PATH, adminAuth(adminKey), observabilityRouter);
    // Also expose under /health/observability for operator convenience.
    app.use(`${HEALTH_PATH}${OBSERVABILITY_PATH}`, adminAuth(adminKey), observabilityRouter);
  } else {
    app.use(OBSERVABILITY_PATH, observabilityRouter);
    app.use(`${HEALTH_PATH}${OBSERVABILITY_PATH}`, observabilityRouter);
  }

  // --- Engine + transcript (conditional auth: no-op local, full hosted) ---
  app.use(ENGINE_API_PATH, apiKeyAuth, engineRouter);
  app.use(YOUTUBE_TRANSCRIPT_API_PATH, apiKeyAuth, youtubeTranscriptRouter);

  // --- Admin key lifecycle (hosted only; disabled in local mode) ---
  if (hosted) {
    app.use(
      "/api/keys",
      adminAuth(adminKey),
      adminRateLimiter,
      authRouter,
    );
  } else {
    // Local mode: key management is irrelevant. Return an explicit 404 so the
    // route surface is honest rather than silently gated.
    app.use("/api/keys", (_req, res) => {
      res.status(404).json({
        error: "Key management is unavailable in local mode. Start in hosted mode (NSECT_HOSTED=1) to manage API keys.",
      });
    });
  }

  // --- Global error handler ---
  app.use((err, _req, res, _next) => {
    const parseFailed = err?.type === "entity.parse.failed"
      || (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, "body"));
    if (parseFailed) {
      return res.status(400).json({ error: "Invalid JSON request body." });
    }
    // Express 5 body-parser emits entity.too.large without a .status property,
    // so it falls through to the 500 catch-all. Map it explicitly to 413.
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body too large. Maximum 10MB." });
    }
    logError("http.unhandled_error", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, config };
}

// Build once at module load. `app` is exported for supertest; `startServer`
// reuses this single instance rather than building a second app. `buildApp` is
// exported so tests can construct a fresh app against a forced runtime mode —
// route wiring (e.g. whether /api/keys is mounted) is fixed at build time.
export function buildApp() {
  return composeApp();
}

const { app, config: appConfig } = composeApp();

export { app };

export function startServer() {
  const listenPort = appConfig.port;
  const server = app.listen(listenPort, () => {
    logEvent("server.started", {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      mode: appConfig.mode,
      port: Number(listenPort),
      engine_path: ENGINE_API_PATH,
      youtube_transcript_path: YOUTUBE_TRANSCRIPT_API_PATH,
    });
  });
  return server;
}

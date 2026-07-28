/**
 * Health surface.
 *
 * Liveness is always open and carries no sensitive data — only status, service,
 * version, uptime. The detailed observability snapshot (memory, success counts,
 * p95, 429s) is a separate route so the composition root can gate it by mode:
 * open in local mode (operator's own machine), admin-gated in hosted mode so it
 * cannot leak internal metrics to unauthenticated callers (point 5).
 */

import { Router } from "express";
import { getObservabilitySnapshot } from "../observability/metrics.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../core/contracts.js";

const livenessRouter = Router();
const observabilityRouter = Router();

/** Liveness: always open, minimal payload — no memory/observability leak. */
livenessRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptime: process.uptime(),
  });
});

/**
 * Detailed observability snapshot. Authorization is applied by the composition
 * root (server/index.js) via middleware mounted before this router — this
 * handler assumes the caller is already authorized.
 */
observabilityRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    observability: getObservabilitySnapshot(),
  });
});

export { livenessRouter, observabilityRouter };

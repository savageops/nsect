/**
 * Runtime configuration owner.
 *
 * Single reader of process.env for the JS server. Reads, validates, and freezes
 * the runtime configuration object once. Per the doctrine config contract
 * (32-configuration), no other module reads process.env directly — callers
 * consume the typed object produced here.
 *
 * The load-bearing decision is `mode`: auth, key-state, rate limiting, and
 * search cooldown are conditional security surfaces (50-security-runtime) that
 * activate only in hosted mode. In local mode (default) the engine runs
 * keyless, unqueued, and ungated — the developer's own machine is the trust
 * boundary.
 *
 * Mode precedence (highest wins):
 *   1. NSECT_HOSTED=1            -> hosted (explicit operator opt-in)
 *   2. NODE_ENV=production        -> hosted (safety: prod cannot run keyless)
 *   3. (otherwise)                -> local
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, "..", "..", "data", "keys.sqlite");
const DEFAULT_PORT = 3000;

/**
 * @typedef {"local" | "hosted"} RuntimeMode
 */

/**
 * @typedef {Object} RuntimeConfig
 * @property {RuntimeMode} mode            Conditional-security trigger.
 * @property {number} port                 HTTP listen port.
 * @property {string | null} adminKey      Admin secret; null when local or unset.
 * @property {string} dbPath               SQLite path for key state.
 * @property {boolean} hosted              Convenience: mode === "hosted".
 */

/**
 * Parse the mode from environment. Precedence is explicit and tested.
 * Pure function over the given env so it is trivially testable.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {RuntimeMode}
 */
export function resolveMode(env = process.env) {
  const hostedFlag = String(env.NSECT_HOSTED ?? "").trim().toLowerCase();
  if (hostedFlag === "1" || hostedFlag === "true" || hostedFlag === "yes") {
    return "hosted";
  }
  const nodeEnv = String(env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") {
    return "hosted";
  }
  return "local";
}

function resolvePort(env) {
  const raw = String(env.PORT ?? "").trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid PORT "${raw}": expected an integer in 1..65535.`,
    );
  }
  return parsed;
}

function resolveAdminKey(env, mode) {
  if (mode !== "hosted") return null;
  const key = String(env.ADMIN_KEY ?? "").trim();
  if (!key) {
    // Fail-fast: hosted mode without an admin secret is a misconfiguration that
    // the operator must fix. Surfacing it at startup beats a silent default.
    throw new Error(
      "ADMIN_KEY is required in hosted mode (NSECT_HOSTED=1 or NODE_ENV=production). " +
        "Set a strong secret before starting the server.",
    );
  }
  return key;
}

function resolveDbPath(env) {
  return String(env.NSECT_DB_PATH ?? "").trim() || DEFAULT_DB_PATH;
}

/**
 * Resolve the optional challenge-solver config. When no API key is set, the
 * solver is disabled and challenges fail honestly (no behavior change). The
 * provider defaults to capsolver (best coverage + price per the 2026 research).
 *
 * @param {NodeJS.ProcessEnv} env
 */
function resolveSolverConfig(env) {
  const apiKey = String(env.NSECT_SOLVER_API_KEY ?? "").trim();
  if (!apiKey) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    provider: String(env.NSECT_SOLVER_PROVIDER ?? "capsolver").trim(),
    apiKey,
    timeout: Number(env.NSECT_SOLVER_TIMEOUT ?? 60),
    kinds: String(env.NSECT_SOLVER_KINDS ?? "cloudflare_turnstile,cloudflare,hcaptcha,recaptcha")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  });
}

let _override = null;

/**
 * Build the frozen runtime config from the environment.
 * Exported primarily for tests; production callers use getRuntimeConfig().
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Readonly<RuntimeConfig>}
 */
export function buildRuntimeConfig(env = process.env) {
  const mode = _override ?? resolveMode(env);
  const port = resolvePort(env);
  const adminKey = resolveAdminKey(env, mode);
  const dbPath = resolveDbPath(env);

  return Object.freeze({
    mode,
    hosted: mode === "hosted",
    port,
    adminKey,
    dbPath,
    solver: resolveSolverConfig(env),
  });
}

let _cached = null;

/**
 * Get the cached runtime config. Reads env exactly once on first access.
 * In local mode the data dir is ensured lazily by the keys module on demand.
 *
 * @returns {Readonly<RuntimeConfig>}
 */
export function getRuntimeConfig() {
  if (!_cached) _cached = buildRuntimeConfig();
  return _cached;
}

/**
 * Ensure the data directory exists for the configured db path.
 * Called once at server startup so the first key op never races mkdir.
 */
export function ensureDataDir() {
  const { dbPath } = getRuntimeConfig();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Test seam: force a mode and rebuild the cached config. Resets the cache so
 * the next getRuntimeConfig() reflects the override. Mirrors the setDbPath/
 * resetDbPath pattern in db/keys.js.
 *
 * @param {RuntimeMode | null} mode  Pass null to clear the override.
 * @param {NodeJS.ProcessEnv} [env]  Optional env to build against.
 */
export function setRuntimeModeForTesting(mode, env = process.env) {
  _override = mode;
  _cached = buildRuntimeConfig(env);
}

/**
 * Test seam: clear the override and cache so the next getRuntimeConfig()
 * re-reads the real environment.
 */
export function resetRuntimeMode() {
  _override = null;
  _cached = null;
}

# Nsect Production Readiness Report

## Objective

Keep CLI, API, and MCP on hardened engine and transcript contracts, minimize drift risk, and preserve deterministic behavior under production load.

## What Is Standardized

### 1. One canonical engine request contract

`server/core/request.js` owns:

- input normalization
- type coercion
- numeric guardrails (`timeout`, `scrollCount`, `scrollDelay`, `delay`, `googleCount`)
- search engine order normalization with Google forced last
- method/format validation
- selector requirement for `method=wait`
- URL validation
- CLI-only artifact controls (`screenshot`, `pdf`)

Shared by:

- CLI entry (`nsect-engine.js`)
- API route (`server/routes/engine.js`)
- Engine runtime (`server/core/engine.js`)

### 2. CLI/API parity

`nsect-engine.js` runs the same runtime pipeline as the API endpoint.

Result:

- lower maintenance surface
- no duplicate constants
- no split behavior between modes

### 3. API error determinism

`POST /api/engine` maps failures into stable classes:

- `400` validation (`VALIDATION_ERROR`)
- `502` upstream navigation/extraction failure (`UPSTREAM_REQUEST`)
- `503` browser launch failure (`BROWSER_LAUNCH`)

### 4. Transcript capability is a first-class runtime surface

`server/core/youtube-transcript.js` now owns the ordered transcript adapter
chain used by:

- `server/routes/youtube-transcript.js`
- `packages/mcp/index.js` via `transcribe-youtube`

Default adapter order:

- `nsect_native`
- `nsect_signal`
- `invidious`
- `piped`
- `yt_dlp`

Result:

- transcript behavior is isolated from engine/search complexity
- API and MCP share one transcript contract
- adapter fallback order is explicit and documented

### 5. Key-store durability and abuse controls

`server/db/keys.js` includes:

- SQLite-backed key state (`data/keys.sqlite`)
- WAL journal mode for safer write durability
- rate-limit normalization with bounded defaults
- per-key search cooldown (minimum six seconds)
- expiry metadata (`expiredAt`)
- normalized key creation parameters

### 6. MCP hardening

`packages/mcp/api-client.js` includes:

- deterministic timeout handling
- robust JSON/non-JSON error parsing
- consistent MCP error envelope output
- env config via:
  - `NSECT_API_URL`
  - `NSECT_API_KEY`

`packages/mcp/index.js` uses that client and exposes engine-aligned tools plus `transcribe-youtube`.

### 7. Native runtime foundation

`rust/` now provides a compiled sibling binary with:

- Axum HTTP bootstrap
- SQLite-backed key state
- browser-backed engine and search fallback
- transcript adapter parity
- CLI engine parity including screenshot/PDF/output-file support
- Windows `.exe` build output

## Verification Matrix

Recommended checks:

- `npm test`
- `npm run test:mcp`
- `npm run test:live`
- `powershell -ExecutionPolicy Bypass -File scripts/test-rust.ps1`
- MCP stdio smoke:
  - `NSECT_API_KEY=sk_test`
  - `NSECT_API_URL=http://127.0.0.1:3000`
  - `node packages/mcp/index.js`
- Transcript runtime smoke:
  - `POST /api/youtube/transcript` against a known public video ID
  - confirm selected adapter method and transcript payload shape

## Operational Notes

- Production must set `ADMIN_KEY` explicitly.
- Rust operators should pin `NSECT_RS_DB_PATH` when they need a non-default SQLite location.
- Preserve request contract parity when adding new engine or transcript capability.
- API and admin keys are header-only.

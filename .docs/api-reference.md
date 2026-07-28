# Nsect API Reference

## Environment

- `PORT` (default `3000`)
- `ADMIN_KEY` (required in production; dev default `admin_change_me`)
- `NSECT_RS_DB_PATH` (Rust runtime only; default `data/keys.sqlite` relative to `rust/`)
- `NSECT_API_URL` (MCP client target, default `http://localhost:3000`)
- `NSECT_API_KEY` (required by MCP server)
- `NSECT_INVIDIOUS_INSTANCES` (optional CSV override for transcript fallback)
- `NSECT_PIPED_INSTANCES` (optional CSV override for transcript fallback)
- `NSECT_YTDLP_COMMANDS` (optional CSV command list fallback for `yt_dlp`)
- Key state is persisted in SQLite WAL at `data/keys.sqlite`

## Authentication

`POST /api/engine` and `POST /api/youtube/transcript` accept API keys from:

- `x-api-key` header
- `Authorization: Bearer <key>`

Admin routes under `/api/keys` require:

- `x-admin-key` header
- or `Authorization: Bearer <admin-key>`

## Endpoints

Runtime note:

- JS runtime and Rust runtime now both implement the published API surface.
- Rust runtime adds a native CLI surface while preserving the same request contract for `/api/engine`.

### `GET /health`

Returns service health and runtime info.

### `POST /api/engine`

Run the Nsect engine against a URL or execute multi-engine search.

Supported fields:

- `url` string (required unless `google` or `query`)
- `google` string (legacy alias for `query`)
- `query` string (required unless `url`)
- `method` one of `direct|wait|scroll|timed|spa`
- `format` one of `text|html|markdown|json|links`
- `verbose` boolean
- `selector` string (required when `method=wait` and search query is not used)
- `timeout` integer `1..180`
- `scrollCount` integer `1..500`
- `scrollDelay` integer `50..10000`
- `delay` integer `0..30000`
- `googleCount` integer `1..50` (max results for search mode)
- `searchEngines` string array or CSV list (`duckduckgo|bing|brave|google`)
- `searchEngines` always forces Google to the final attempt when included
- `proxy` string
- `cookies` array or JSON string
- `headers` object or JSON string

Error contract:

- `400` validation failure (`code: "VALIDATION_ERROR"`)
- `403` invalid/revoked key
- `429` rate-limited key or search cooldown violation
- `502` upstream navigation/extraction failure (`code: "UPSTREAM_REQUEST"`)
- `503` browser launch failure (`code: "BROWSER_LAUNCH"`)

### `POST /api/youtube/transcript`

Fetch transcript text/segments for a YouTube video with ordered adapter fallback.

Supported fields:

- `url` string (required unless `videoId`)
- `videoId` string (required unless `url`)
- `language` string (default `en`)
- `format` one of `text|json|markdown`
- `methods` string array or CSV list (`nsect_native|nsect_signal|invidious|piped|yt_dlp`)
- `includeSegments` boolean (default `false`)
- `includeAutoCaptions` boolean (default `true`)
- `timeout` integer `5..120`

Method behavior:

- `nsect_native`: direct watch-page caption extraction path
- `nsect_signal`: direct InnerTube player extraction path
- `invidious`: Invidious API fallback
- `piped`: Piped API fallback
- `yt_dlp`: `yt-dlp` command fallback

Error contract:

- `400` validation failure (`code: "VALIDATION_ERROR"`)
- `403` invalid/revoked key
- `429` key rate-limit violation
- `502` all transcript adapters failed (`code: "TRANSCRIPT_UNAVAILABLE"`)

### `POST /api/keys/create`

Creates a key.

Body:

- `label` string (default `unnamed`)
- `rateLimit` integer (`1..10000`, default `100`)
- `searchCooldownSeconds` integer (`>=6`, default `6`)
- `expiresIn` integer seconds (`>0`) or `null`

### `GET /api/keys`

Lists masked key records.

### `GET /api/keys/:key`

Returns masked details for one key.

### `DELETE /api/keys/:key`

Revokes a key.

## MCP Tools

The MCP server exposes:

- `run-engine`
- `engine-search`
- `search-web`
- `transcribe-youtube`
- `extract-links`
- `engine-page-metadata`

Tools call `POST /api/engine` and `POST /api/youtube/transcript` via `packages/mcp/api-client.js`.
Search tools state the 6 second per-key cooldown and Google-last fallback order in their descriptors.

## Test Commands

- `npm test` - full Vitest matrix
- `npm run test:mcp` - MCP client + stdio smoke tests
- `npm run test:live` - opt-in live browser/network coverage
- `powershell -ExecutionPolicy Bypass -File scripts/test-rust.ps1` - Rust compile + unit verification

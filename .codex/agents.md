# nsect — Agent Operating Contract

Repo-level contract for agents working on this codebase. Aligns with and defers
to the global operating contract at `~/.codex/AGENTS.md`; this file captures
product-specific decisions that are not derivable from the generic doctrine.

## What This Product Is

`nsect` (published as `@nsect/cli` on npm) is programmable web-retrieval infrastructure:
a headless-browser engine for page extraction and multi-engine SERP fallback,
plus a resilient YouTube-transcript adapter chain. It runs in two parallel
runtimes — JavaScript (Node/Express) and Rust (axum) — that mirror each other
at the contract level. The same request normalization, key system, and mode
gate apply to both.

## Unified Retrieval Model (load-bearing design decision)

The retrieval contract is **one normalized surface** across CLI, HTTP API, and
MCP. The design goal: the caller doesn't need to be a scraping expert.

### Strategies (replaces the old 5-method decision tree)

A single `strategy` field with a smart `auto` default. The legacy `method`
field is a backward-compat alias mapped onto these.

| Strategy | When | What it does |
|---|---|---|
| `auto` (default) | 90% of pages | Detects JS challenges and waits for self-resolution, detects SPAs and waits for render, detects infinite-scroll feeds and scrolls, then extracts. |
| `fast` | Known static pages | Network-idle only. |
| `patient` | Slow renders | Selector-wait or network-idle + `renderWait`. |
| `spa` | Client-rendered apps | Network-idle + render wait. |
| `scroll` | Infinite feeds | Scroll loop + network-idle. |

### Challenge bypass layer (`server/core/challenge.js`, `rust/src/challenge.rs`)

Detects JS challenge pages (Cloudflare, DataDome, PerimeterX, hCaptcha,
reCAPTCHA, Akamai, generic interstitials, hard blocks) and waits for
auto-resolution (default 15s budget). With the existing stealth stack, many
challenges self-clear. Interactive challenges (hCaptcha/reCAPTCHA puzzles) are
detected but NOT solved — they fail honestly with `errorCode: "CHALLENGE_BLOCKED"`
instead of returning the challenge page as content.

- `auto` strategy enables challenge handling by default.
- Other strategies opt in with `bypassChallenges: true`.
- `challengeTimeout` (0-120s, default 15) bounds the wait. 0 disables.

### Response envelope (unified type contract)

`output` is a **string** for `text`/`html`/`markdown` and a **parsed value**
(object/array) for `json`/`links`. The `format` field tells the caller which to
expect. No double-parsing needed.

```json
{ "success": true, "format": "text",  "output": "...", "meta": {...} }
{ "success": true, "format": "json",  "output": { "title": "...", ... }, "meta": {...} }
{ "success": true, "format": "links", "output": [{ "href": "...", "text": "..." }], "meta": {...} }
```

### Field naming (snake_case canonical, aliases accepted)

The normalizer accepts snake_case, camelCase, and kebab-case. Canonical names:
`strategy`, `max_results`, `render_wait`, `challenge_timeout`, `bypass_challenges`.
Legacy aliases (`method`, `googleCount`, `google`) still work.

### MCP `fetch` tool (zero-friction entry point)

The `fetch` MCP tool auto-routes based on input: YouTube URL → transcript,
`query` (no URL) → search, any other URL → page extraction. Specialized tools
(`run-engine`, `search-web`, `transcribe-youtube`) stay for explicit control.

## Stealth + extraction + solver layers (2026 upgrade)

Three researched-and-verified upgrade layers, each closing a specific gap found
during real-world testing. All are opt-in or adaptive — no behavior change for
existing callers unless they configure the new env vars.

### Stealth layer (`server/core/engine.js`)

- **rebrowser-puppeteer-core** — patches the `Runtime.enable` CDP leak (the #1
  DataDome detection vector), the `sourceURL` leak, and the
  `__puppeteer_utility_world__` name leak. These are protocol-level leaks that
  `puppeteer-extra-plugin-stealth` cannot fix. Loaded via `puppeteer.addExtra()`.
- **Proxy auth** — `page.authenticate()` before navigation (was missing entirely;
  residential proxies like BrightData/Smartproxy/Oxylabs now work). Accepts
  `http://user:pass@host:port` or separate `proxyUser`/`proxyPass` fields.
- **Client Hints consistency** — `setUserAgent(ua, {userAgentData})` with full
  high-entropy fields (architecture, bitness, platformVersion, uaFullVersion).
  Adaptive: falls back to JS injection of `navigator.userAgentData` on older
  bundled Chromium that rejects the CDP param.
- **Real Chrome executablePath** — prefers a stable Chrome install over the
  bundled Chromium-for-Testing (whose TLS JA3 matches no real Chrome release).
  Override with `NSECT_USE_BUNDLED_CHROME=1`.
- **Deleted the self-inflicted `navigator.webdriver` leak** — the manual
  `defineProperty` getter returned a JS function source, not `[native code]`,
  which was itself a detection vector. The stealth plugin handles webdriver.

### Extraction layer (`server/core/extractor.js`)

- **defuddle** — DOM-scoring main-content extraction (replaces naive
  innerText + noise-selector strip). Scores elements by text density, strips
  boilerplate, returns cleaned HTML + markdown.
- **JSON-LD capture** — parses `<script type="application/ld+json">` for
  schema.org structured data (datePublished, author, articleBody, product
  data). Surfaces in `meta.schemaOrg`, `meta.author`, `meta.published`.
- **Fallback cascade** — defuddle → `<article>`/`<main>`/`[role=main]` →
  legacy noise strip. Robust for arbitrary pages, not just articles.

### Solver layer (`server/core/solver.js`) — opt-in

- Solves interactive challenges (Cloudflare Turnstile, hCaptcha, reCAPTCHA)
  via CapSolver/2Captcha/Anti-Captcha. Plugs into the existing
  `CHALLENGE_BLOCKED` branch — if a solver key is configured and the challenge
  kind is eligible, it solves; otherwise fails honestly as before.
- **PX "press and hold" is NOT API-solvable** — documented boundary. The path
  is proxy + fingerprint (which the stealth layer provides), not a solver call.
- Activation: `NSECT_SOLVER_API_KEY` env var. No key = solver disabled, no
  behavior change.

### Honest residuals (architectural ceilings, documented)

- **Prototype descriptor leaks** — spoofed properties return JS function
  source, not `[native code]`. Only fixable at the C++ engine layer
  (Camoufox/BotBrowser). Node/Puppeteer cannot reach this.
- **TLS/HTTP2 fingerprinting** — cipher suite ordering is compiled into
  BoringSSL. Real-Chrome `executablePath` mitigates; full fix requires a
  patched Chromium binary (BotBrowser/CloakBrowser).

## Deployment Mode (load-bearing design decision)

Auth, API-key state, rate limiting, and search cooldown are **conditional
security surfaces** (doctrine `50-security-runtime: Conditional Security
Surfaces`). They activate only in **hosted mode**; in **local mode** (default)
the engine runs keyless, unqueued, and ungated.

| | Local mode | Hosted mode |
|---|---|---|
| **Trigger** | default | `NSECT_HOSTED=1` OR `NODE_ENV=production` |
| **Engine/transcript** | no auth, no limits | API key + rate limit + 6s search cooldown |
| **/api/keys/** | 404 (disabled) | admin auth + per-IP limiter |
| **/health** | liveness only | liveness only |
| **/health/observability** | open | admin-gated |
| **ADMIN_KEY** | ignored | **required** (fail-fast startup if unset) |

**Config owner:** `server/core/config.js` (JS) and `rust/src/config.rs` (Rust)
are the single readers of `process.env`/`getenv`. No other module reads env
directly. Mode precedence: `NSECT_HOSTED` > `NODE_ENV=production` > local.

**Safety invariant:** `NODE_ENV=production` *always* implies hosted mode. You
cannot run a production deploy keyless by accident — the config owner
fail-fasts at startup if `ADMIN_KEY` is empty in hosted mode.

## Key System

- Keys are stored **only** as a sha-256 hash (`key_hash` PRIMARY KEY). The
  plaintext `sk_…` secret is returned exactly once at creation and never
  persisted. A DB leak cannot reveal usable credentials.
- Validation hashes the incoming key and looks up by hash; the plaintext never
  touches the query path after creation.
- Admin secret comparison is **timing-safe** (`crypto.timingSafeEqual` in JS,
  `subtle::ConstantTimeEq` in Rust). No plaintext `!==` comparisons.
- Admin auth is **header-only** (`x-admin-key`); API keys use
  `Authorization: Bearer`. Two schemes, two transports — no ambiguity.
- Public listings expose only a masked hash prefix (`keyHash`), never the
  plaintext secret.
- Per-IP admin rate limiting (10/min, in-memory) prevents unbounded key
  minting. Single-host guarantee; multi-host needs a shared store.

## Architecture Ownership

| Concern | JS owner | Rust owner |
|---|---|---|
| Config / mode | `server/core/config.js` | `rust/src/config.rs` |
| Key store | `server/db/keys.js` | `rust/src/db.rs` |
| Auth middleware | `server/middleware/auth.js` | `rust/src/auth.rs` |
| Route wiring | `server/index.js` | `rust/src/routes.rs` |
| Request contract | `server/core/request.js` | `rust/src/request.rs` |
| Engine runtime | `server/core/engine.js` | `rust/src/engine.rs` |
| Transcript chain | `server/core/youtube-transcript.js` | `rust/src/transcript.rs` |
| Observability | `server/observability/` | `rust/src/observability.rs` |
| MCP server | `packages/mcp/` | — |

## Testing Discipline

- Default `npm test` / `cargo test` runs **fully offline**. Live integration
  tests are gated behind `LIVE_INTEGRATION=1`.
- Tests change **only** because the contract changed (doctrine
  `60-testing:make-the-code-pass-the-tests`). The two-mode gate is a contract
  change — both modes are tested explicitly.
- Never weaken assertions, skip tests, or bend mocks to achieve green.

## Residuals (honest, documented)

- **Rust DB concurrency:** `Mutex<Connection>` serializes all key ops. Local
  mode avoids the DB entirely; hosted high-throughput pooling is a separate
  benchmarked effort.
- **Per-IP limiting is process-local:** fine for single-host SaaS; multi-host
  needs Redis or equivalent.
- **Search-result selectors** remain CSS-fragile by nature; the multi-engine
  fallback and generic extractor mitigate in practice.

## Quick Reference

```bash
# Local mode (default) — keyless, free
node api.js

# Hosted mode — requires ADMIN_KEY
NSECT_HOSTED=1 ADMIN_KEY="your-strong-secret" node api.js

# Create a key (hosted only)
bash scripts/create-api-key.sh --admin-key "your-strong-secret" --label prod
```

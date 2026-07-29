# Changelog

All notable changes to nsect are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-07-29

### Product rename
- Renamed `insect` → `nsect` across all code, docs, env vars, file names,
  package names, Rust crate, and skill packages (87 files changed)
- Published as `@nsect/cli` on npm (the unscoped `nsect` name was blocked by
  npm's similarity filter vs `net`/`next`)

### Deployment mode (conditional security)
- **Local mode** (default): engine runs keyless, ungated, async — no auth,
  no rate limiting, no search cooldown
- **Hosted mode** (`NSECT_HOSTED=1` or `NODE_ENV=production`): full API key
  auth, rate limiting, 6s search cooldown, admin route protection
- Single config owner (`server/core/config.js`) is the only reader of
  `process.env`; fail-fast if hosted mode has no `ADMIN_KEY`

### Security hardening
- API keys stored as sha-256 hashes (`key_hash` PRIMARY KEY); plaintext
  returned once at creation, never persisted
- Timing-safe admin secret comparison (`crypto.timingSafeEqual` / `subtle::ConstantTimeEq`)
- No default admin secret — hosted mode requires a real `ADMIN_KEY`
- `/health` split: minimal liveness (always open) vs `/observability` (admin-gated)
- Per-IP admin rate limiter (10/min) prevents unbounded key minting
- Proxy auth via `page.authenticate()` (residential proxies now work)
- Express 5 `entity.too.large` → 413 (was falling through to 500)
- Expired-key error semantics consistent across calls (was "expired" then "revoked")

### Stealth layer (anti-bot evasion)
- **rebrowser-puppeteer-core**: patches `Runtime.enable` CDP leak (#1 DataDome
  vector), `sourceURL` leak, `__puppeteer_utility_world__` name leak
- **Client Hints consistency**: full high-entropy `userAgentData` (architecture,
  bitness, platformVersion, uaFullVersion) with adaptive fallback
- **Real Chrome executablePath**: prefers stable Chrome over Chromium-for-Testing
  for genuine TLS JA3 fingerprint
- **Timezone via CDP**: `page.emulateTimezone()` replaces prototype hack
  (fixes `Intl.DateTimeFormat` inconsistency)
- **Fingerprint coherence** on all three axes:
  - Platform → UA (Win32 for Windows UAs, MacIntel for Mac, etc.)
  - WebGL vendor/renderer → platform (platform-aware coherent pairs)
  - Locale → timezone (geographically matched, no en-AU + America/New_York)
- Deleted self-inflicted `navigator.webdriver` leak
- Empty-content guard: PX/imperva blank interstitials fail honestly with
  `CHALLENGE_BLOCKED` instead of silent empty success
- Canvas/video/iframe guard prevents false-positive challenge detection

### Challenge bypass layer
- Challenge detection for Cloudflare, DataDome, PerimeterX, hCaptcha,
  reCAPTCHA, Akamai, generic interstitials, hard blocks
- Challenge resolution: waits for auto-clearing (15s default) with `auto` strategy
- **CapSolver/2Captcha/Anti-Captcha solver** (opt-in via `NSECT_SOLVER_API_KEY`):
  solves Turnstile/hCaptcha/reCAPTCHA via createTask/getTaskResult API
- PX "press and hold" documented as not API-solvable (needs proxy+fingerprint)
- `detectInfiniteScroll` fixed: removed `main` selector (false-positived on
  long articles)

### Extraction layer
- **defuddle** DOM-scoring extraction (replaces naive innerText + noise strip)
- **JSON-LD/schema.org** structured data capture (author, datePublished, article type)
- **Fallback cascade**: defuddle → `<article>`/`<main>` → legacy noise strip
- **Unified response envelope**: `output` is string for text/html/markdown,
  parsed object/array for json/links
- Single atomic `page.evaluate()` for HTML + links + meta + JSON-LD (no TOCTOU race)
- defuddle failure logged (was silently swallowed)

### Unified retrieval model
- Strategy model: `auto` (default) / `fast` / `patient` / `spa` / `scroll`
- Legacy `method` field kept as backward-compat alias
- Unified `fetch` MCP tool: auto-routes YouTube → transcript, query → search,
  URL → page extraction
- Field naming: snake_case canonical, camelCase/kebab-case aliases accepted
- `maxResults` canonical name (legacy `googleCount` alias)
- Timeout split: `timeout` (overall deadline) + `renderWait` (extra render time)

### MCP server
- Optional API key (local mode = keyless)
- `run-engine` tool updated from `method` to `strategy` parameter
- `transcribe-youtube` validates YouTube URLs
- `fetch` tool rejects ambiguous `url` + `query` (was silently dropped)
- `fetch` YouTube path coerces unsupported formats (html/links → text)
- `extract-links` uses `asText()` for structured arrays (was `[object Object]`)
- `engine-page-metadata` guards against missing/null output (was TypeError crash)
- `buildMetaSummary` coerces all interpolated fields (was showing `undefined`)
- MCP api-client error handling: non-Error throws + `err.cause` surfacing

### YouTube transcript improvements
- InnerTube fallback version updated from Jan 2024 to Jul 2026
- Instance circuit breaker: failed Invidious/Piped instances marked down for
  5 minutes (both JS and Rust runtimes)
- yt-dlp flags: added `--no-playlist` and `--age-limit 99` for safety

### Scripts / operator tools
- `harvest-search.mjs`: manifest written in `finally` (partial failures now
  recorded); spawn error checked; query-file ENOENT caught; numeric validation
- `save-transcript.mjs`: module guard `resolve()` fix; spawn error checked;
  `throw` instead of `process.exit`
- `render-mcp-config.sh`: `shift 2` guarded against missing option values
- `slugify` and `collectQueries` exported for testability

### Rust runtime parity
- Solver module (`solver.rs`) with full CapSolver/2Captcha integration
- Extraction cascade: semantic `<article>`/`<main>` tier + JSON-LD
- Challenge-blocked branch with solver wiring
- Empty-content guard + canvas/visual heuristic in `challenge.rs`
- `detectInfiniteScroll` `main` removed (JS fix mirrored)
- `challenge.rs` uses `document.title` instead of `tab.get_url()` proxy
- WebGL vendor/renderer coherent pairs (platform-aware)
- Locale → timezone geographic coherence
- Transcript circuit breaker (mirrors JS)
- `CHALLENGE_BLOCKED` → 502 status mapping (was 500)
- Expired-key error semantics consistency (was "expired" then "revoked")
- Cross-platform browser path detection (Windows + macOS + Linux)
- LazyLock regex caching in `formatters.rs` and `transcript.rs`
- User-agent reports real crate version via `env!("CARGO_PKG_VERSION")`

### Performance benchmarks
- Regex `htmlToMarkdown` is 50-100x faster than turndown — keep the regex
- defuddle extraction adds 36-394ms overhead vs raw innerText — acceptable
  given browser render time dominates (2-15s); quality improvement justifies cost

### CI / testing
- **GitHub Actions CI** (`.github/workflows/ci.yml`): JS tests + Rust tests +
  syntax check on every push/PR
- **517 total tests** (was 192):
  - JS: 336 passed + 19 skipped (live integration, gated)
  - Rust: 181 passed
- LIVE_INTEGRATION tests: CreepJS fingerprint validation, solver e2e pipeline,
  live search engine selector validation (DDG/Bing/Brave/Google)

### libgen skill integration
- `nsect_fetch.py` bridge for browser-based retrieval
- `mirrors.py` solver fallback with `_is_challengeable()` filter
- SSL-fix verification on library.lol (cert-ignore)

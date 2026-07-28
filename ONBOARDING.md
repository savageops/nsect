# Nsect Onboarding and Setup Guide

## Who This Guide Is For

Anyone who needs to run, develop, or integrate Nsect:

- backend/API maintainers
- MCP/tooling integrators
- operators hosting Nsect as a SaaS API

## Prerequisites

- Node.js 20+
- npm 10+
- Bash shell for scripts
- Network access for target pages you scrape

## Fastest Setup Path

```bash
bash scripts/bootstrap.sh --install-browser
```

What this does:

- installs root dependencies
- installs `packages/mcp` dependencies
- optionally downloads Chromium for Puppeteer
- creates `.env` from `.env.example` if missing

## Manual Setup Path

```bash
npm install
cd packages/mcp && npm install && cd ../..
npm run install-browser
cp .env.example .env
```

## Start the API

```bash
bash scripts/start-api.sh
```

Default API URL:

- `http://localhost:3000`

## Optional Native Runtime

If you want the compiled Rust sibling instead of the Node server:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-rust.ps1
powershell -ExecutionPolicy Bypass -File scripts/run-rust.ps1
```

Or:

```bash
bash scripts/build-rust.sh
bash scripts/run-rust.sh
```

Rust scope:

- `/health`
- `/api/keys/*`
- `/api/engine`
- `/api/youtube/transcript`
- `engine` CLI subcommand with page extraction, search fallback, screenshot, PDF, and output-file support
- `transcribe-youtube` CLI subcommand with native `--output` file support

Rust runtime env:

- `PORT` controls the listening port
- `ADMIN_KEY` protects admin routes
- `NSECT_RS_DB_PATH` overrides the Rust SQLite location

Packaged runtime skill:

- `packages/skills/nsect-rs-runtime`
- alias trigger skill: `packages/skills/nsect`
- launcher script: `packages/skills/nsect-rs-runtime/scripts/run-nsect-rs.ps1`
- transcript capture helper: `packages/skills/nsect-rs-runtime/scripts/save-nsect-transcript.ps1`
- bundled binary: `packages/skills/nsect-rs-runtime/assets/bin/nsect-rs.exe`

Cross-runtime operator scripts:

- `node scripts/save-transcript.mjs --runtime js|rust ...`
- `node scripts/harvest-search.mjs --runtime js|rust ...`

## Create an API Key

```bash
bash scripts/create-api-key.sh \
  --admin-key admin_change_me \
  --label onboarding-user \
  --rate-limit 120 \
  --search-cooldown 6
```

## Validate Connectivity

```bash
bash scripts/smoke-test.sh --base-url http://localhost:3000 --api-key sk_xxx
```

This checks:

- `/health`
- authenticated `/api/engine`

For YouTube transcript capability, run:

```bash
curl -sS http://localhost:3000/api/youtube/transcript \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_xxx" \
  -d '{
    "videoId":"dQw4w9WgXcQ",
    "format":"text",
    "methods":["nsect_native","nsect_signal","invidious","piped","yt_dlp"]
  }'
```

## Run the MCP Server

Set env first:

```bash
export NSECT_API_URL=http://localhost:3000
export NSECT_API_KEY=sk_xxx
```

Optional transcript adapter tuning:

```bash
export NSECT_INVIDIOUS_INSTANCES=https://invidious.nerdvpn.de,https://yewtu.be
export NSECT_PIPED_INSTANCES=https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de
export NSECT_YTDLP_COMMANDS=yt-dlp,yt-dlp.exe
```

Then run:

```bash
npm run mcp
```

You should see:

- `nsect MCP server running on stdio`

## Generate MCP Client Config

```bash
bash scripts/render-mcp-config.sh \
  --api-url https://api.yourdomain.com \
  --api-key sk_xxx
```

## Run Tests

```bash
npm test
npm run test:mcp
npm run test:live
```

Rust checks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-rust.ps1
```

## Common Troubleshooting

1. Browser launch fails
- Run: `npm run install-browser`

2. `403` on engine API
- Check your `x-api-key` value
- Ensure the key is active and not rate-limited
- API keys are accepted via headers only (`x-api-key` or `Authorization: Bearer <key>`)

3. `429` on search requests
- Search mode enforces a minimum 6 second cooldown per key
- Wait for the retry window from the response and retry

4. MCP exits immediately
- Verify `NSECT_API_KEY` is set
- Verify API is reachable from your MCP runtime environment

5. Admin key routes failing
- Check `ADMIN_KEY` in `.env` and request header `x-admin-key`

6. Rust key state appears in the wrong location
- Set `NSECT_RS_DB_PATH` before running `scripts/run-rust.ps1` or `scripts/run-rust.sh`
- Default Rust path is `rust/data/keys.sqlite`

6. Transcript route returns `502`
- The adapter chain exhausted all providers (`nsect_native`, `nsect_signal`, `invidious`, `piped`, `yt_dlp`)
- Ensure outbound network access to YouTube
- Ensure `yt-dlp` is installed or reachable via `NSECT_YTDLP_COMMANDS`

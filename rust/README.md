# nsect-rs

Native Rust runtime for Nsect.

## Scope

- `GET /health`
- admin key lifecycle routes backed by SQLite WAL
- API key validation and bearer/header auth
- `POST /api/engine`
- `POST /api/youtube/transcript`
- `engine` CLI subcommand for page extraction and search
- `transcribe-youtube` CLI subcommand with native `--output` file support
- Windows-native binary output via `cargo build --release`

## Parity Status

- `engine + search`: live and working
- `youtube transcript`: live and working
- `health + key state`: live and working
- `HTTP server bootstrap`: live and working
- `artifact output`: screenshot, PDF, and text-file output supported from CLI mode

## Build

### PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-rust.ps1
```

### Bash

```bash
bash scripts/build-rust.sh
```

Release artifact:

- `rust/target/release/nsect-rs.exe` on Windows

## Run

### PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-rust.ps1
```

### Bash

```bash
bash scripts/run-rust.sh
```

Default server URL:

- `http://127.0.0.1:3000`

Runtime env:

- `PORT` for the HTTP listener
- `ADMIN_KEY` for admin route protection
- `NSECT_RS_DB_PATH` to override the Rust SQLite file path

Packaged Codex skill:

- `packages/skills/nsect-rs-runtime`
- `packages/skills/nsect`
- `packages/skills/nsect-rs-runtime/scripts/run-nsect-rs.ps1`
- `packages/skills/nsect-rs-runtime/scripts/save-nsect-transcript.ps1`
- `packages/skills/nsect-rs-runtime/assets/bin/nsect-rs.exe`

Cross-runtime repo scripts:

- `node scripts/save-transcript.mjs --runtime rust ...`
- `node scripts/harvest-search.mjs --runtime rust ...`

## Test

### PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-rust.ps1
```

### Bash

```bash
bash scripts/test-rust.sh
```

## CLI Example

```bash
cargo run --manifest-path rust/Cargo.toml -- transcribe-youtube --video-id dQw4w9WgXcQ --format text --timeout 20
```

```bash
cargo run --manifest-path rust/Cargo.toml -- transcribe-youtube --video-id dQw4w9WgXcQ --format json --output out/transcript.json
```

```bash
cargo run --manifest-path rust/Cargo.toml -- engine --url https://example.com --format text --timeout 15
```

## API Example

Boot the server, create an admin key in the same way as the JS runtime, then call:

```bash
curl -sS http://127.0.0.1:3000/api/engine \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_xxx" \
  -d '{
    "query":"example domain",
    "googleCount":3,
    "searchEngines":["duckduckgo","bing","brave","google"],
    "format":"json"
  }'
```

```bash
curl -sS http://127.0.0.1:3000/api/youtube/transcript \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_xxx" \
  -d '{
    "videoId":"dQw4w9WgXcQ",
    "format":"json",
    "methods":["nsect_native","nsect_signal","invidious","piped","yt_dlp"]
  }'
```

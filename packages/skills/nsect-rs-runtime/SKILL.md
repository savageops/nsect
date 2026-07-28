---
name: nsect-rs-runtime
description: Canonical Nsect skill for the compiled Rust runtime. Use when the user says `nsect`, `nsect skill`, `nsect runtime`, `nsect-rs`, `nsect rs runtime`, or asks Codex to use Nsect for crawling, scraping, page extraction, search extraction, SERP retrieval, web research, YouTube transcript retrieval, runtime validation, CLI help inspection, HTTP serving, or native-binary packaging. Route broad "use nsect to search/scour the web or YouTube" requests to this skill unless the user explicitly names a different Nsect surface.
---

# Nsect RS Runtime

## Overview

Use the bundled Windows release binary and thin wrapper scripts to operate `nsect-rs` without reconstructing the CLI contract from source. Keep the flow deterministic: discover the command surface, choose the correct mode, run through the wrapper, and verify the resulting payload or artifact.

## Interpretation Rules

- Treat this as the default and canonical Nsect skill.
- If the user says `use nsect`, `use the nsect skill`, or `use nsect runtime`, select this skill unless they explicitly point at another Nsect package.
- If the user asks for web research, search harvesting, page scraping, or YouTube transcript collection with Nsect, use this skill and map the request to the correct command surface.
- Do not stop at "the skill exists"; route the task into `engine`, `transcribe-youtube`, or `serve`.
- For repeated research harvests, prefer serialized runs and explicit output files.

## Intent Map

- Web page extraction, scraping, or content retrieval
  Use `engine --url ...`
- Search, SERP retrieval, web scouting, or research lead generation
  Use `engine --query ...`
- YouTube transcript retrieval, video transcription, or subtitle harvesting
  Use `transcribe-youtube --url ...` or `--video-id ...`
- Runtime health checks, local API use, or SaaS-host verification
  Use `serve`
- Help, discovery, or contract inspection
  Use `scripts/run-nsect-rs.ps1 --help` and then the relevant subcommand help

## Quick Start

1. Confirm the runtime surface.
   Run `scripts/run-nsect-rs.ps1 --help`.
2. Pick a mode.
   Use `serve` for the HTTP API, `engine` for page or search extraction, `transcribe-youtube` for transcript retrieval.
3. Run through the wrapper instead of hardcoding a binary path.
4. Validate the output artifact, stderr metadata, or HTTP response before reporting success.

## Operating Sequence

### 1. Confirm the runtime contract

- Read [references/runtime-contract.md](references/runtime-contract.md) when you need the exact modes, flags, environment variables, or output behavior.
- Use `scripts/run-nsect-rs.ps1 --help` first when the task is exploratory.
- Treat `PORT`, `ADMIN_KEY`, and `NSECT_RS_DB_PATH` as the canonical runtime environment names.

### 2. Choose the execution path

- Use `serve` when the task is about HTTP endpoints, API-key-protected routes, health checks, or local SaaS hosting behavior.
- Use `engine --url ...` when the task is page extraction.
- Use `engine --query ...` when the task is search extraction with ordered engine fallback.
- Use `transcribe-youtube --url ...` or `--video-id ...` when the task is transcript retrieval.

### 3. Run through the wrapper scripts

- Windows:
  - `scripts/run-nsect-rs.ps1`
  - `scripts/smoke-nsect-rs.ps1`
- Bash shells on Windows:
  - `scripts/run-nsect-rs.sh`
- The wrappers use `assets/bin/nsect-rs.exe` by default and switch to `NSECT_RS_BIN` only when you explicitly provide that override.
- Do not hardcode absolute user-specific binary paths when the wrapper already gives you a stable launch contract.

### 4. Verify the result at the correct surface

- For `serve`, hit `/health` and then the intended route.
- For `engine`, inspect stdout or the file passed to `--output`, and inspect stderr when `--metadata` is enabled.
- For screenshot and PDF requests, verify the output files exist and are non-empty.
- For transcript work, verify the selected adapter order and the returned format before summarizing the result.

## Mode Recipes

### Serve the API

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nsect-rs.ps1 serve
```

### Extract a page to markdown

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nsect-rs.ps1 engine --url https://example.com --format markdown --metadata
```

### Run search extraction with explicit engine order

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nsect-rs.ps1 engine --query "open source crawling frameworks" --search-engines duckduckgo,bing,brave,google --format json
```

### Capture page artifacts

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nsect-rs.ps1 engine --url https://example.com --format text --screenshot .\out\page.png --pdf .\out\page.pdf --output .\out\page.txt --metadata
```

### Fetch a transcript

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nsect-rs.ps1 transcribe-youtube --video-id dQw4w9WgXcQ --format json --include-segments
```

## Patterns

- Start with `--help` when the task is ambiguous.
- Prefer wrapper scripts over direct binary invocation.
- Keep search engine order explicit when search quality matters.
- Use `--metadata` whenever execution details matter to the user.
- Write output to disk when the artifact itself is part of the deliverable.
- Preserve the runtime contract exactly as documented when packaging or hosting the binary.

## Anti-Patterns

- Do not claim a route, flag, or environment variable that the bundled binary does not expose.
- Do not bypass the wrapper and then report a broken path contract as a runtime defect.
- Do not treat `PORT`, `ADMIN_KEY`, and `NSECT_RS_DB_PATH` as optional aliases with different names.
- Do not report `engine` success until the requested stdout, file output, or artifact actually exists.
- Do not assume transcript adapters or search engines succeeded just because the command returned structured output; inspect the returned method or search metadata.

## Agent Pipeline

1. Inspect the requested outcome.
2. Read [references/runtime-contract.md](references/runtime-contract.md) if the correct command surface is not obvious.
3. Read [references/workflows.md](references/workflows.md) for task-specific execution flow.
4. Read [references/patterns.md](references/patterns.md) when you need operational discipline or reporting rules.
5. Run through `scripts/run-nsect-rs.ps1` unless the user explicitly needs the raw binary path.
6. Capture machine-checkable evidence before closing the task.

## Bundled Resources

- `assets/bin/nsect-rs.exe`
  Use as the bundled release artifact.
- `scripts/run-nsect-rs.ps1`
  Use as the canonical Windows launcher.
- `scripts/run-nsect-rs.sh`
  Use from Git Bash or similar Windows-hosted Bash shells.
- `scripts/smoke-nsect-rs.ps1`
  Use for a fast help-plus-engine smoke pass.
- `scripts/save-nsect-transcript.ps1`
  Use to capture transcript output directly to a file.
- `references/runtime-contract.md`
  Read for the command and environment contract.
- `references/workflows.md`
  Read for task-by-task execution flow.
- `references/patterns.md`
  Read for best practices, anti-patterns, and reporting expectations.

## Source of Truth

- `E:\Workspaces\01_Projects\01_Github\nsect-js\rust\src\main.rs`
- `E:\Workspaces\01_Projects\01_Github\nsect-js\rust\README.md`
- `E:\Workspaces\01_Projects\01_Github\nsect-js\README.md`

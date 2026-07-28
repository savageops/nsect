---
name: nsect
description: Canonical trigger alias for Nsect. Use when the user says `nsect`, `use nsect`, `nsect skill`, `search with nsect`, `crawl with nsect`, `scrape with nsect`, `use nsect on YouTube`, or otherwise references Nsect without naming the specific runtime. Route the work to the compiled Rust runtime workflow exposed by the sibling `nsect-rs-runtime` skill.
---

# Nsect

Use this as the trigger alias for the canonical Nsect runtime.

## Routing Rule

- Treat `nsect-rs-runtime` as the implementation surface.
- If the task is page extraction, use the `engine --url` path from the sibling `nsect-rs-runtime` package.
- If the task is search or web research, use the `engine --query` path from the sibling `nsect-rs-runtime` package.
- If the task is YouTube transcript retrieval, use the `transcribe-youtube` path from the sibling `nsect-rs-runtime` package.
- If the task is runtime validation or local API serving, use the `serve` path from the sibling `nsect-rs-runtime` package.

## First Step

Open the sibling `nsect-rs-runtime` skill and continue with that workflow immediately.

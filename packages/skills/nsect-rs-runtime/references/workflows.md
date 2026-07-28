# Workflows

## Discover the CLI Surface

1. Run `scripts/run-nsect-rs.ps1 --help`.
2. Run the relevant subcommand help if the task is mode-specific.
3. Use the subcommand examples as the starting point instead of reconstructing flags from memory.

## Run Local HTTP Serving

1. Set `PORT`, `ADMIN_KEY`, and `NSECT_RS_DB_PATH` when the task needs explicit runtime state.
2. Launch `scripts/run-nsect-rs.ps1 serve`.
3. Verify `GET /health`.
4. Exercise the intended endpoint after health succeeds.

## Extract a Page

1. Use `engine --url`.
2. Choose the lightest format that satisfies the request.
3. Enable `--metadata` when reporting execution details matters.
4. Write `--output`, `--screenshot`, or `--pdf` when the artifact is part of the deliverable.

## Run Search Extraction

1. Use `engine --query`.
2. Set `--search-engines` explicitly when the task depends on crawl order.
3. Serialize harvest-style search runs instead of launching multiple concurrent `engine --query` calls against the same runtime state.
4. Treat search results as successful only after the response contains usable normalized results.
5. Inspect metadata for engine attempts when the result quality looks wrong.

## Fetch a Transcript

1. Use `transcribe-youtube --video-id` for the cleanest locator when the ID is known.
2. Prefer native `--output` when you are calling the Rust runtime directly.
3. Use `scripts/save-nsect-transcript.ps1` when you want the wrapper to handle the save path for you.
4. Use `--methods` only when you need to pin or inspect adapter order.
5. Use `--include-segments` when timestamps matter.
6. Confirm the returned method and format before summarizing the transcript.

## Run a Fast Smoke Pass

1. Run `scripts/smoke-nsect-rs.ps1`.
2. Review the created output file path.
3. Inspect command stderr if the smoke pass fails.

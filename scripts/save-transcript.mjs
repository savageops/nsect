#!/usr/bin/env node

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchYouTubeTranscript } from "../server/core/youtube-transcript.js";

function ensureParentDir(filePath) {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function resolveRustCommand(repoRoot) {
  const binaryPath = resolve(repoRoot, "rust", "target", "release", "nsect-rs.exe");
  if (existsSync(binaryPath)) {
    return { command: binaryPath, args: [] };
  }
  return {
    command: "cargo",
    args: ["run", "--manifest-path", resolve(repoRoot, "rust", "Cargo.toml"), "--"],
  };
}

async function runJsTranscript(options, outputPath) {
  const result = await fetchYouTubeTranscript({
    url: options.url,
    videoId: options["video-id"],
    language: options.language,
    format: options.format,
    methods: options.methods,
    includeSegments: options["include-segments"],
    includeAutoCaptions: !options["no-auto-captions"],
    timeout: Number(options.timeout),
  });

  if (!result.success) {
    throw new Error(result.error || result.errorCode || "Transcript fetch failed");
  }

  ensureParentDir(outputPath);
  writeFileSync(outputPath, result.output || "", "utf-8");
  return outputPath;
}

function runRustTranscript(repoRoot, options, outputPath) {
  ensureParentDir(outputPath);
  const rust = resolveRustCommand(repoRoot);
  const args = [
    ...rust.args,
    "transcribe-youtube",
    "--format",
    options.format,
    "--timeout",
    String(options.timeout),
    "--output",
    outputPath,
  ];

  if (options.url) {
    args.push("--url", options.url);
  }
  if (options["video-id"]) {
    args.push("--video-id", options["video-id"]);
  }
  if (options.language) {
    args.push("--language", options.language);
  }
  if (options["include-segments"]) {
    args.push("--include-segments");
  }
  if (!options["no-auto-captions"]) {
    args.push("--include-auto-captions");
  }
  if (options.methods) {
    args.push("--methods", options.methods);
  }

  const result = spawnSync(rust.command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  return outputPath;
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      runtime: { type: "string", default: "js" },
      url: { type: "string" },
      "video-id": { type: "string" },
      language: { type: "string", default: "en" },
      format: { type: "string", default: "json" },
      methods: { type: "string" },
      timeout: { type: "string", default: "20" },
      "include-segments": { type: "boolean", default: false },
      "no-auto-captions": { type: "boolean", default: false },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return values;
}

function printHelp() {
  console.log(`
save-transcript.mjs

USAGE:
  node scripts/save-transcript.mjs --runtime <js|rust> --video-id <id> --output <path> [options]

OPTIONS:
  --runtime <name>        Runtime to use: js or rust (default: js)
  --video-id <id>         YouTube video ID
  --url <url>             YouTube watch URL
  --language <tag>        Transcript language tag (default: en)
  --format <format>       text | json | markdown (default: json)
  --methods <csv>         Comma-delimited adapter order override
  --timeout <sec>         Transcript timeout in seconds (default: 20)
  --include-segments      Keep segment timestamps in the output
  --no-auto-captions      Disable fallback to auto-generated captions
  --output <path>         File path for the saved transcript
  --help                  Show this help
`);
}

export async function main() {
  const options = parseCli();
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.output) {
    throw new Error("--output is required");
  }
  if (!options.url && !options["video-id"]) {
    throw new Error("--url or --video-id is required");
  }
  if (!["js", "rust"].includes(options.runtime)) {
    throw new Error("--runtime must be js or rust");
  }

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputPath = resolve(repoRoot, options.output);
  const savedPath = options.runtime === "rust"
    ? runRustTranscript(repoRoot, options, outputPath)
    : await runJsTranscript(options, outputPath);

  console.log(`Transcript saved: ${savedPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[error]", error.message);
    process.exit(1);
  });
}

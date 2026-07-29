#!/usr/bin/env node

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function slugify(value, index) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `${String(index + 1).padStart(3, "0")}-${slug || "query"}.json`;
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

function acquireLock(lockPath) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath) {
  if (existsSync(lockPath)) {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function collectQueries(options, repoRoot) {
  const queries = [];
  if (options.query) {
    const list = Array.isArray(options.query) ? options.query : [options.query];
    queries.push(...list.map((value) => value.trim()).filter(Boolean));
  }
  if (options["query-file"]) {
    const filePath = resolve(repoRoot, options["query-file"]);
    try {
      const content = readFileSync(filePath, "utf-8");
      queries.push(
        ...content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#")),
      );
    } catch (err) {
      throw new Error(`--query-file not found or unreadable: ${filePath} (${err.message})`);
    }
  }
  return queries;
}

function runJsQuery(repoRoot, options, query, outputPath) {
  return spawnSync("node", [
    "nsect-engine.js",
    "--query",
    query,
    "--format",
    options.format,
    "--search-engines",
    options["search-engines"],
    "--timeout",
    String(options.timeout),
    ...(options.metadata ? ["--metadata"] : []),
    "--output",
    outputPath,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function runRustQuery(repoRoot, options, query, outputPath) {
  const rust = resolveRustCommand(repoRoot);
  return spawnSync(rust.command, [
    ...rust.args,
    "engine",
    "--query",
    query,
    "--format",
    options.format,
    "--search-engines",
    options["search-engines"],
    "--timeout",
    String(options.timeout),
    ...(options.metadata ? ["--metadata"] : []),
    "--output",
    outputPath,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      runtime: { type: "string", default: "rust" },
      query: { type: "string", multiple: true },
      "query-file": { type: "string" },
      "output-dir": { type: "string" },
      "search-engines": { type: "string", default: "duckduckgo,bing,brave,google" },
      format: { type: "string", default: "json" },
      timeout: { type: "string", default: "30" },
      "delay-ms": { type: "string", default: "250" },
      metadata: { type: "boolean", default: true },
      "lock-name": { type: "string", default: "nsect-search-harvest" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  return values;
}

function printHelp() {
  console.log(`
harvest-search.mjs

USAGE:
  node scripts/harvest-search.mjs --runtime <js|rust> --query "..." --output-dir <dir> [options]
  node scripts/harvest-search.mjs --runtime <js|rust> --query-file <path> --output-dir <dir> [options]

OPTIONS:
  --runtime <name>          Runtime to use: js or rust (default: rust)
  --query <text>            Search query to run; repeat for multiple queries
  --query-file <path>       File with one query per line
  --output-dir <dir>        Directory for harvested JSON payloads
  --search-engines <csv>    Search engine order (default: duckduckgo,bing,brave,google)
  --format <format>         Output format for engine payloads (default: json)
  --timeout <sec>           Runtime timeout in seconds (default: 30)
  --delay-ms <ms>           Delay between serialized queries (default: 250)
  --metadata                Print runtime metadata to stderr (default: true)
  --lock-name <name>        Lock directory name under .tmp/locks
  --help                    Show this help
`);
}

export async function main() {
  const options = parseCli();
  if (options.help) {
    printHelp();
    return;
  }

  if (!["js", "rust"].includes(options.runtime)) {
    throw new Error("--runtime must be js or rust");
  }

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const queries = collectQueries(options, repoRoot);
  if (queries.length === 0) {
    throw new Error("Provide at least one --query or a --query-file");
  }
  if (!options["output-dir"]) {
    throw new Error("--output-dir is required");
  }
  // Validate numeric options to prevent NaN propagation.
  if (options.timeout && !Number.isFinite(Number(options.timeout))) {
    throw new Error(`--timeout must be a number, got: ${options.timeout}`);
  }
  if (options["delay-ms"] && !Number.isFinite(Number(options["delay-ms"]))) {
    throw new Error(`--delay-ms must be a number, got: ${options["delay-ms"]}`);
  }

  const outputDir = resolve(repoRoot, options["output-dir"]);
  ensureDir(outputDir);
  const locksDir = resolve(repoRoot, ".tmp", "locks");
  ensureDir(locksDir);
  const lockPath = resolve(locksDir, `${options["lock-name"]}.lock`);

  if (!acquireLock(lockPath)) {
    throw new Error(`Search harvest lock is active at ${lockPath}. Run one harvest at a time.`);
  }

  const manifest = {
    runtime: options.runtime,
    searchEngines: options["search-engines"].split(",").map((value) => value.trim()).filter(Boolean),
    format: options.format,
    timeout: Number(options.timeout),
    generatedAt: new Date().toISOString(),
    queries: [],
  };

  try {
    for (const [index, query] of queries.entries()) {
      const filename = slugify(query, index);
      const outputPath = resolve(outputDir, filename);
      const result = options.runtime === "rust"
        ? runRustQuery(repoRoot, options, query, outputPath)
        : runJsQuery(repoRoot, options, query, outputPath);

      if (result.error) {
        throw new Error(`Spawn failed for '${query}': ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`Harvest query failed (exit ${result.status}, signal ${result.signal || "none"}) for '${query}'`);
      }

      manifest.queries.push({
        query,
        outputPath,
      });

      if (index < queries.length - 1) {
        await sleep(Number(options["delay-ms"]));
      }
    }
  } finally {
    releaseLock(lockPath);
    // Always write the manifest — even on partial failure — so the caller
    // can inspect which queries succeeded before the failure point.
    const manifestPath = resolve(outputDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    console.log(`Harvest manifest saved: ${manifestPath} (${manifest.queries.length}/${queries.length} queries)`);
  }
}

// Resolve argv[1] to absolute before pathToFileURL — relative paths can throw.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("[error]", error.message);
    process.exit(1);
  });
}

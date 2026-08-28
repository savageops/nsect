/**
 * dsh-nsect — keyless search provider for the DeepSeek Harness `ctx.web` seam.
 *
 * Registers one search provider (registry id `nsect`) so the stable
 * model-facing `web_search` tool runs on the local nsect CLI — nsect's
 * stealth-browser multi-engine pipeline — instead of a keyed remote API.
 *
 * Every design decision below encodes a deployment lesson from the
 * 2026-08-28 CLI Cloud migration audit; keep them true when editing:
 *
 * 1. THE SEAM HAS NO FALLBACK. `resolveProvider` in @deepseek-ai/dsh-web
 *    resolves the `web.searchProvider` id strictly at call time: an id that
 *    is not registered throws `WEB_PROVIDER_CONFIGURED_MISSING` and a
 *    registered-but-unavailable provider throws
 *    `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` — either way EVERY `web_search`
 *    call fails, not just this provider. `available()` is therefore kept a
 *    cheap existsSync over the exact resolution order used at search time,
 *    so the GUI/tool error always points at the real obstacle.
 *
 * 2. THE BINARY IS RESOLVED, NEVER ASSUMED. The predecessor package
 *    (dsh-web-search-nsect) hard-coded ~/.dsh/tools/nsect and a missing
 *    install silently disabled search. Resolution order here:
 *    settings `nsect.bin` → `$DSH_NSECT_BIN` → the legacy
 *    ~/.dsh/tools/nsect install → this package's own `@nsect/cli`
 *    dependency. Installing this plugin alone is sufficient.
 *
 * 3. PLUGIN-TOGGLE OWNS NO STATE FILE. A `# managed:plugin-toggle` block at
 *    the end of the profile's cordis.patch.yml is the toggle's only state
 *    store, and later rows win — that block silently disabled the
 *    predecessor while the same file's earlier rows enabled it. This
 *    package keeps the loader entry id `web-search-nsect` so existing
 *    rows (including managed blocks) keep addressing one stable id; the
 *    README documents the one-command diagnosis.
 *
 * 4. CONFIG LIVES IN A REAL SETTINGS NAMESPACE. Settings.yaml sections whose
 *    owner plugin is uninstalled are dead config (silently ignored), so the
 *    namespace here ("nsect") is owned by this very plugin and stays live:
 *    values are editable in the GUI / settings.yaml and hot-publish through
 *    the settings-file watcher — no restart.
 *
 * 5. PATCH EDITS HOT-RECOMPOSE; HOST CODE CHANGES DO NOT. The profile boot
 *    installs a patch watcher (and creates the HMR plugin on demand), so
 *    enable/disable/config rows apply to the running tree within seconds.
 *    A change to THIS file still requires a host restart — say so in PRs.
 *
 * @module dsh-nsect
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "schemastery";

export const name = "dsh-nsect";
/** The web seam is the only hard dependency; the settings seam is optional. */
export const inject = ["web"];

/** Loader entry id — kept identical to dsh-web-search-nsect for drop-in upgrades. */
export const LOADER_ID = "web-search-nsect";
/** Search-provider registry id — the value `web.searchProvider` must name. */
const PROVIDER_ID = "nsect";
/** Settings namespace owned (and therefore kept live) by this plugin. */
const SETTINGS_NS = "nsect";

/**
 * Plugin config (cordis loader config) and base for the `nsect` settings
 * namespace. Every field is optional; schema defaults match the CLI's own.
 *
 * Values resolve per search call in this order: the live settings namespace
 * (user layer of settings.yaml / GUI) → these loader-config defaults → the
 * built-in defaults below, so an operator override never needs a restart.
 */
export const Config = z.object({
	/** Absolute path to an nsect CLI launcher; wins over every other candidate. */
	bin: z.string().default(""),
	/** Engine budget in seconds, passed as the CLI's --timeout. */
	timeoutSeconds: z.number().step(1).min(5).max(120).default(45),
	/** Result cap, passed as --max-results; the seam re-caps request.maxResults. */
	maxResults: z.number().step(1).min(1).max(50).default(10),
	/** Engine fallback order CSV ("bing,duckduckgo,..."); empty = CLI default. */
	searchEngines: z.string().default(""),
	/** Pre-engine randomized delay floor in ms, passed as --delay. */
	delayMs: z.number().step(1).min(0).max(30000).default(1000),
	/** Headless browser (default true); false passes --no-headless for debugging. */
	headless: z.boolean().default(true)
});

const BUILTIN_DEFAULTS = {
	bin: "",
	timeoutSeconds: 45,
	maxResults: 10,
	searchEngines: "",
	delayMs: 1000,
	headless: true
};

/** Legacy install convention of the predecessor plugin (~/.dsh/tools/nsect). */
const legacyToolsBin = () => join(homedir(), ".dsh", "tools", "nsect", "node_modules", ".bin", "nsect");

/** Resolved once per process; null when the bundled dependency is absent. */
let bundledCliDirCache;
function bundledCliDir() {
	if (bundledCliDirCache === undefined) {
		try {
			bundledCliDirCache = dirname(createRequire(import.meta.url).resolve("@nsect/cli/package.json"));
		} catch {
			bundledCliDirCache = null;
		}
	}
	return bundledCliDirCache;
}

/**
 * Resolve how to launch the nsect engine, mirroring the documented order.
 * Returns a launch description or null — `available()` and `search()` share
 * it so the two can never disagree about whether the provider can run.
 */
function resolveLaunch(settingsBin) {
	const candidates = [
		settingsBin && settingsBin.trim() !== "" ? { command: settingsBin.trim(), args: [], cwd: dirname(settingsBin.trim()) } : null,
		process.env.DSH_NSECT_BIN ? { command: process.env.DSH_NSECT_BIN, args: [], cwd: dirname(process.env.DSH_NSECT_BIN) } : null,
		existsSync(legacyToolsBin()) ? { command: legacyToolsBin(), args: [], cwd: join(legacyToolsBin(), "..", "..", "..") } : null
	].filter(Boolean);
	if (candidates.length > 0) return candidates[0];
	const pkgDir = bundledCliDir();
	if (pkgDir !== null) {
		// Spawn via node: the engine file inside the npm package has no +x bit.
		return { command: process.execPath, args: [join(pkgDir, "nsect-engine.js")], cwd: pkgDir };
	}
	return null;
}

/** Run the engine once and capture stdout, killing at the outer budget. */
function runEngine(launch, args, budgetMs, signal) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(launch.command, [...launch.args, ...args], {
			cwd: launch.cwd,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), budgetMs);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			settled = true;
			rejectPromise(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			if (code === 0) resolvePromise(stdout);
			else rejectPromise(new Error(`nsect exited ${code}: ${stderr.slice(0, 400)}`));
		});
	});
}

/**
 * Mount the provider. Settings registration is best-effort: on a host
 * without a settings seam the provider still runs on loader config and
 * built-in defaults.
 * @param ctx - host plugin context (cordis).
 * @param config - schema-resolved loader config for this row.
 */
export function apply(ctx, config = {}) {
	/** Live settings values; null until (and unless) the settings seam mounts. */
	let settingsScope = null;
	ctx.inject(["settings"], (sctx) => {
		settingsScope = sctx.settings.register(SETTINGS_NS, Config, { base: { ...BUILTIN_DEFAULTS, ...config } });
	});
	/** Current values, read at call time so edits hot-apply. */
	const readConfig = () => {
		if (settingsScope !== null) return settingsScope.get();
		return { ...BUILTIN_DEFAULTS, ...config };
	};
	ctx.effect(
		() =>
			ctx.web.registerSearchProvider({
				id: PROVIDER_ID,
				available() {
					const { bin } = readConfig();
					const launch = resolveLaunch(bin);
					if (launch === null) return false;
					// The bundled path launches node (always present), so gate on
					// the engine file; wrapper candidates gate on the launcher.
					return launch.command === process.execPath ? existsSync(launch.args[0]) : existsSync(launch.command);
				},
				async search(request, signal) {
					const query = request.query?.trim() ?? "";
					if (query === "") throw Object.assign(new Error("empty query"), { code: "WEB_PROVIDER_ERROR" });
					const cfg = readConfig();
					const launch = resolveLaunch(cfg.bin);
					if (launch === null) {
						throw Object.assign(
							new Error("nsect engine not found; install @nsect/cli (bundled dependency), set nsect.bin in settings, or export DSH_NSECT_BIN"),
							{ code: "WEB_PROVIDER_ERROR" }
						);
					}
					const args = [
						"--query",
						query,
						"--format",
						"json",
						"--timeout",
						String(cfg.timeoutSeconds),
						// Engine target = the operator's setting. request.maxResults is
						// the CALLER's ceiling and is enforced by the seam itself
						// (capSources) — passing it here would let a per-call cap
						// silently override the configured engine budget.
						"--max-results",
						String(cfg.maxResults),
						"--delay",
						String(cfg.delayMs)
					];
					if (cfg.searchEngines.trim() !== "") args.push("--search-engines", cfg.searchEngines.trim());
					if (cfg.headless === false) args.push("--no-headless");
					let output;
					try {
						// Outer budget: the CLI's own --timeout fires first; this only
						// reaps a hung browser (same +15s headroom policy as before).
						output = await runEngine(launch, args, (cfg.timeoutSeconds + 15) * 1000, signal);
					} catch (error) {
						if (signal?.aborted) throw Object.assign(new Error("search aborted"), { code: "WEB_PROVIDER_CANCELLED" });
						throw Object.assign(new Error(`nsect search failed: ${error.message}`), { code: "WEB_PROVIDER_ERROR" });
					}
					let parsed;
					try {
						parsed = JSON.parse(output);
					} catch {
						throw Object.assign(new Error("nsect returned non-JSON output"), { code: "WEB_PROVIDER_ERROR" });
					}
					const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.results) ? parsed.results : []);
					const sources = rows
						.filter((row) => typeof row?.url === "string" && row.url !== "")
						.map((row) => ({
							url: row.url,
							title: typeof row.title === "string" ? row.title : undefined,
							snippet: typeof row.snippet === "string" ? row.snippet : undefined
						}));
					// The seam enforces request.maxResults on the result itself;
					// report no additional truncation of our own.
					return { sources, truncated: false };
				}
			}),
		"dsh-nsect: search provider"
	);
}

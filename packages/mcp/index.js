#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MCP_CONFIG_EXAMPLE,
  createApiClient,
  readMcpConfig,
  toMcpError,
} from "./api-client.js";
import {
  ENGINE_API_PATH,
  MIN_SEARCH_COOLDOWN_SECONDS,
  YOUTUBE_TRANSCRIPT_API_PATH,
} from "../../server/core/contracts.js";

const { apiBase, apiKey } = readMcpConfig();
const SEARCH_ENGINES = ["duckduckgo", "bing", "brave", "google"];
const TRANSCRIPT_ADAPTERS = ["nsect_native", "nsect_signal", "invidious", "piped", "yt_dlp"];

// The API key is optional: in local mode the server runs keyless, so absence is
// not an error. Warn only when a key is absent AND the server looks hosted.
if (!apiKey) {
  console.error("nsect MCP: NSECT_API_KEY not set — running in keyless (local) mode.");
  console.error("If the target server runs hosted, set NSECT_API_KEY in your MCP config:");
  console.error(JSON.stringify(MCP_CONFIG_EXAMPLE, null, 2));
}

const apiClient = createApiClient({
  apiBase,
  apiKey,
});

const server = new McpServer(
  { name: "nsect", version: "1.0.0" },
  {
    instructions: [
      "Nsect: unified web retrieval. Fetch pages, run web search, and get YouTube transcripts.",
      "Prefer the 'fetch' tool as the default — it auto-routes to the right backend (page/search/transcript) based on your input, with the 'auto' strategy that detects and bypasses JS challenges (Cloudflare, DataDome, etc.) automatically.",
      "Use the specialized tools (run-engine, search-web, transcribe-youtube) only when you need explicit control over strategy or parameters.",
      "For known dynamic sites, you can pass strategy='spa' or 'patient'. For infinite feeds, strategy='scroll'. The default 'auto' handles all of these.",
      `In hosted mode, search enforces a minimum ${MIN_SEARCH_COOLDOWN_SECONDS}s cooldown per API key. Local mode is ungated.`,
    ].join("\n"),
  },
);

const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"];

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return YOUTUBE_HOSTS.includes(host);
  } catch {
    return false;
  }
}

// The unified fetch tool — the zero-friction entry point. Auto-routes based on
// the input: YouTube URL -> transcript, query (no URL) -> search, else -> page.
server.tool(
  "fetch",
  [
    "Unified web retrieval. Auto-routes to the right backend based on input:",
    "- YouTube URL -> transcript (5-adapter fallback chain).",
    "- A 'query' field with no URL -> multi-engine web search.",
    "- Any other URL -> page extraction.",
    "Uses the 'auto' strategy by default, which detects and waits for JS challenges",
    "(Cloudflare, DataDome, PerimeterX) to self-resolve, detects SPAs, and scrolls",
    "infinite feeds — so you usually don't need to pick a strategy.",
    "Output is text by default; pass format='markdown' for cleaner prose or 'json' for structured.",
  ].join("\n"),
  {
    url: z.string().optional().describe("URL to fetch (page or YouTube video)."),
    query: z.string().optional().describe("Search query (when fetching search results, not a page)."),
    format: z.enum(["text", "html", "markdown", "json", "links"]).default("markdown"),
    strategy: z.enum(["auto", "fast", "patient", "spa", "scroll"]).default("auto"),
    timeout: z.number().int().min(1).max(180).default(30),
    max_results: z.number().int().min(1).max(50).default(10),
  },
  async (params) => {
    // Route 1: YouTube -> transcript
    if (params.url && isYouTubeUrl(params.url)) {
      const result = await apiClient.postJson(YOUTUBE_TRANSCRIPT_API_PATH, {
        url: params.url,
        format: params.format === "html" ? "text" : params.format,
        timeout: 20,
      });
      if (!result.ok) return toMcpError(result.errorMessage);
      return {
        content: [{ type: "text", text: asText(result.payload.output) + buildMetaSummary(result.payload.meta) }],
      };
    }

    // Route 2: query (no URL) -> search
    if (params.query && !params.url) {
      const payload = await callEngineApi({
        query: params.query,
        googleCount: params.max_results,
        format: params.format,
      });
      if (payload.isError) return payload;
      return {
        content: [{ type: "text", text: asText(payload.output) + buildMetaSummary(payload.meta) }],
      };
    }

    // Route 3: URL -> page extraction
    if (!params.url) {
      return toMcpError("Either 'url' or 'query' is required.");
    }
    const payload = await callEngineApi({
      url: params.url,
      format: params.format,
      strategy: params.strategy,
      timeout: params.timeout,
    });
    if (payload.isError) return payload;
    return {
      content: [{ type: "text", text: asText(payload.output) + buildMetaSummary(payload.meta) }],
    };
  },
);

async function callEngineApi(body) {
  const result = await apiClient.postJson(ENGINE_API_PATH, body);
  if (!result.ok) {
    return toMcpError(result.errorMessage);
  }
  return result.payload;
}

function buildMetaSummary(meta) {
  if (!meta) return "";
  if (meta.type === "search" || meta.type === "google") {
    return `\n\n---\nQuery: "${meta.query}" | Engine: ${meta.engine || "none"} | Results: ${meta.resultCount} | ${meta.elapsed}s`;
  }
  if (meta.type === "youtube_transcript") {
    return `\n\n---\nVideo: ${meta.videoId} | Method: ${meta.method || "none"} | Segments: ${meta.segmentCount || 0} | ${meta.elapsed}s`;
  }
  if (meta.type === "page") {
    return `\n\n---\nMeta: ${meta.textLength || 0} chars | ${meta.linksFound || 0} links | ${meta.elapsed}s`;
  }
  return "";
}

function asText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

server.tool(
  "run-engine",
  [
    "Run a page extraction job through the Nsect engine API.",
    "Supports five loading methods: direct, wait, scroll, timed, and spa.",
    "Supports output formats: text, html, markdown, json, and links.",
  ].join("\n"),
  {
    url: z.string().url().describe("Absolute page URL including protocol."),
    format: z.enum(["text", "html", "markdown", "json", "links"]).default("text"),
    method: z.enum(["direct", "wait", "scroll", "timed", "spa"]).default("direct"),
    verbose: z.boolean().default(false).describe("Include noisy page regions when true."),
    selector: z.string().optional().describe("Required when method='wait'."),
    timeout: z.number().int().min(1).max(180).default(30),
    scroll_count: z.number().int().min(1).max(500).default(20),
    scroll_delay: z.number().int().min(50).max(10000).default(800),
    delay: z.number().int().min(0).max(30000).default(1000),
  },
  async (params) => {
    const payload = await callEngineApi({
      url: params.url,
      format: params.format,
      method: params.method,
      verbose: params.verbose,
      selector: params.selector,
      timeout: params.timeout,
      scrollCount: params.scroll_count,
      scrollDelay: params.scroll_delay,
      delay: params.delay,
    });

    if (payload.isError) return payload;

    return {
      content: [{ type: "text", text: asText(payload.output) + buildMetaSummary(payload.meta) }],
    };
  },
);

server.tool(
  "search-web",
  [
    "Run a multi-engine web search with fallback and return ranked results.",
    "Default order: duckduckgo,bing,brave,google (Google is always forced to the final attempt).",
    `In hosted mode, search requests enforce a minimum ${MIN_SEARCH_COOLDOWN_SECONDS} second cooldown per API key; local mode is ungated.`,
    "Output can be text, json, links, or markdown.",
  ].join("\n"),
  {
    query: z.string().min(1).describe("Search query text."),
    count: z.number().int().min(1).max(50).default(10),
    format: z.enum(["text", "json", "links", "markdown"]).default("text"),
    engines: z.array(z.enum(SEARCH_ENGINES)).optional(),
  },
  async (params) => {
    const payload = await callEngineApi({
      query: params.query,
      googleCount: params.count,
      format: params.format,
      searchEngines: params.engines,
    });

    if (payload.isError) return payload;

    return {
      content: [{ type: "text", text: asText(payload.output) + buildMetaSummary(payload.meta) }],
    };
  },
);

server.tool(
  "transcribe-youtube",
  [
    "Fetch a YouTube transcript using a resilient adapter chain.",
    "Fallback order defaults to: nsect_native -> nsect_signal -> invidious -> piped -> yt_dlp.",
    "When one adapter fails, Nsect automatically tries the next.",
    "Nsect-native methods are direct integration paths without third-party API dependencies.",
    "Output supports text, json, and markdown.",
  ].join("\n"),
  {
    url: z.string().url().optional().describe("YouTube video URL."),
    video_id: z.string().optional().describe("YouTube video ID (11 chars)."),
    language: z.string().default("en").describe("Preferred transcript language tag."),
    format: z.enum(["text", "json", "markdown"]).default("text"),
    timeout: z.number().int().min(5).max(120).default(20),
    include_segments: z.boolean().default(false),
    include_auto_captions: z.boolean().default(true),
    methods: z.array(z.enum(TRANSCRIPT_ADAPTERS)).optional(),
  },
  async (params) => {
    if (!params.url && !params.video_id) {
      return toMcpError("Either 'url' or 'video_id' is required.");
    }

    const result = await apiClient.postJson(YOUTUBE_TRANSCRIPT_API_PATH, {
      url: params.url,
      videoId: params.video_id,
      language: params.language,
      format: params.format,
      timeout: params.timeout,
      includeSegments: params.include_segments,
      includeAutoCaptions: params.include_auto_captions,
      methods: params.methods,
    });

    if (!result.ok) {
      return toMcpError(result.errorMessage);
    }

    return {
      content: [{ type: "text", text: asText(result.payload.output) + buildMetaSummary(result.payload.meta) }],
    };
  },
);

server.tool(
  "extract-links",
  [
    "Extract all hyperlinks from a page.",
    "Useful for crawl seeding and site mapping.",
  ].join("\n"),
  {
    url: z.string().url(),
    verbose: z.boolean().default(false),
  },
  async (params) => {
    const payload = await callEngineApi({
      url: params.url,
      format: "links",
      verbose: params.verbose,
    });

    if (payload.isError) return payload;

    return {
      content: [{ type: "text", text: payload.output || "No links found." }],
    };
  },
);

server.tool(
  "engine-page-metadata",
  [
    "Fetch a quick metadata snapshot for a page.",
    "Returns title, URL, text length, links count, and meta tags.",
  ].join("\n"),
  {
    url: z.string().url(),
  },
  async (params) => {
    const payload = await callEngineApi({
      url: params.url,
      format: "json",
    });

    if (payload.isError) return payload;

    let parsed;
    try {
      parsed = typeof payload.output === "string"
        ? JSON.parse(payload.output)
        : payload.output;
    } catch (err) {
      return toMcpError(`Failed to parse metadata payload: ${err.message}`);
    }

    const summaryLines = [
      `Title: ${parsed.title || "(none)"}`,
      `URL: ${parsed.url || "(none)"}`,
      `Text length: ${parsed.text?.length || 0} chars`,
      `Links: ${parsed.links?.length || 0}`,
      "",
      "Meta tags:",
    ];
    for (const [key, value] of Object.entries(parsed.meta || {})) {
      summaryLines.push(`  ${key}: ${value}`);
    }

    return {
      content: [{ type: "text", text: summaryLines.join("\n") }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("nsect MCP server running on stdio");

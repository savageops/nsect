import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const YOUTUBE_TRANSCRIPT_METHODS = Object.freeze([
  "nsect_native",
  "nsect_signal",
  "invidious",
  "piped",
  "yt_dlp",
]);

const DEFAULT_TRANSCRIPT_METHODS = [...YOUTUBE_TRANSCRIPT_METHODS];
const DEFAULT_TIMEOUT_SECONDS = 20;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 120;
const SUPPORTED_OUTPUT_FORMATS = Object.freeze(["text", "json", "markdown"]);

const DEFAULT_INVIDIOUS_INSTANCES = Object.freeze([
  "https://invidious.nerdvpn.de",
  "https://invidious.protokolla.fi",
  "https://yewtu.be",
]);

const DEFAULT_PIPED_INSTANCES = Object.freeze([
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.aeong.one",
]);

function parseListFromEnv(value) {
  if (!value || typeof value !== "string") return null;
  const list = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export class YouTubeTranscriptValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "YouTubeTranscriptValidationError";
    this.code = "VALIDATION_ERROR";
    this.field = field;
  }
}

function toOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function toInteger(value, field, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    throw new YouTubeTranscriptValidationError(`'${field}' must be an integer`, field);
  }
  if (numeric < min || numeric > max) {
    throw new YouTubeTranscriptValidationError(
      `'${field}' must be between ${min} and ${max}`,
      field,
    );
  }
  return numeric;
}

function normalizeLanguage(value) {
  const language = (toOptionalString(value) || "en").toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(language)) {
    throw new YouTubeTranscriptValidationError(
      "'language' must be an IETF language tag like en or en-US",
      "language",
    );
  }
  return language;
}

function normalizeOutputFormat(value) {
  const format = (toOptionalString(value) || "text").toLowerCase();
  if (!SUPPORTED_OUTPUT_FORMATS.includes(format)) {
    throw new YouTubeTranscriptValidationError(
      `'format' must be one of: ${SUPPORTED_OUTPUT_FORMATS.join(", ")}`,
      "format",
    );
  }
  return format;
}

function normalizeMethods(value) {
  if (value === undefined || value === null || value === "") {
    return [...DEFAULT_TRANSCRIPT_METHODS];
  }

  let list;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string") {
    list = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  } else {
    throw new YouTubeTranscriptValidationError(
      "'methods' must be an array or comma-delimited string",
      "methods",
    );
  }

  const normalized = list.map((method) => String(method).trim().toLowerCase());
  if (normalized.length === 0) {
    throw new YouTubeTranscriptValidationError("'methods' cannot be empty", "methods");
  }
  for (const method of normalized) {
    if (!YOUTUBE_TRANSCRIPT_METHODS.includes(method)) {
      throw new YouTubeTranscriptValidationError(
        `'methods' contains unsupported adapter '${method}'. Valid: ${YOUTUBE_TRANSCRIPT_METHODS.join(", ")}`,
        "methods",
      );
    }
  }
  return [...new Set(normalized)];
}

function normalizeUrl(value) {
  const url = toOptionalString(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new YouTubeTranscriptValidationError("'url' must be http:// or https://", "url");
    }
  } catch {
    throw new YouTubeTranscriptValidationError("'url' must be a valid absolute URL", "url");
  }
  return url;
}

export function parseYouTubeVideoId(value) {
  const raw = toOptionalString(value);
  if (!raw) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
    return raw;
  }

  try {
    const parsed = new URL(raw);

    if (parsed.hostname === "youtu.be") {
      const candidate = parsed.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate || "") ? candidate : null;
    }

    if (parsed.searchParams.has("v")) {
      const candidate = parsed.searchParams.get("v");
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate || "") ? candidate : null;
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const embedIndex = pathParts.findIndex((part) => part === "embed" || part === "shorts");
    if (embedIndex >= 0) {
      const candidate = pathParts[embedIndex + 1];
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate || "") ? candidate : null;
    }
  } catch {
    return null;
  }

  return null;
}

export function normalizeYouTubeTranscriptRequest(input = {}) {
  const url = normalizeUrl(input.url);
  const videoIdFromInput = toOptionalString(input.videoId ?? input.video_id);
  const derivedVideoId = parseYouTubeVideoId(videoIdFromInput || url);

  if (!derivedVideoId) {
    throw new YouTubeTranscriptValidationError(
      "A valid 'videoId' or YouTube 'url' is required",
      "videoId",
    );
  }

  return {
    url: url || `https://www.youtube.com/watch?v=${derivedVideoId}`,
    videoId: derivedVideoId,
    language: normalizeLanguage(input.language ?? input.lang),
    methods: normalizeMethods(input.methods),
    format: normalizeOutputFormat(input.format),
    includeSegments: toBoolean(input.includeSegments ?? input.include_segments, false),
    includeAutoCaptions: toBoolean(
      input.includeAutoCaptions ?? input.include_auto_captions,
      true,
    ),
    timeoutSeconds: toInteger(
      input.timeout ?? input.timeoutSeconds ?? input.timeout_seconds,
      "timeout",
      MIN_TIMEOUT_SECONDS,
      MAX_TIMEOUT_SECONDS,
      DEFAULT_TIMEOUT_SECONDS,
    ),
  };
}

function decodeEntities(input = "") {
  return String(input)
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function normalizeSegmentText(input) {
  return decodeEntities(String(input || ""))
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimestampToSeconds(value) {
  const raw = String(value || "").trim().replace(",", ".");
  const parts = raw.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 2) {
    minutes = Number(parts[0]);
    seconds = Number(parts[1]);
  } else {
    hours = Number(parts[0]);
    minutes = Number(parts[1]);
    seconds = Number(parts[2]);
  }

  if (![hours, minutes, seconds].every((part) => Number.isFinite(part))) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeSegments(segments) {
  const normalized = [];
  for (const segment of segments || []) {
    const text = normalizeSegmentText(segment?.text);
    if (!text) continue;
    const start = Number.isFinite(segment?.start) ? Number(segment.start) : null;
    const duration = Number.isFinite(segment?.duration) ? Number(segment.duration) : null;
    normalized.push({
      text,
      start,
      duration,
    });
  }
  return normalized;
}

function segmentsToText(segments) {
  return segments
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTranscriptOutput(format, payload) {
  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }
  if (format === "markdown") {
    return [
      `# Transcript: ${payload.videoId}`,
      "",
      `- Language: ${payload.language}`,
      `- Method: ${payload.method}`,
      `- Segments: ${payload.segmentCount}`,
      "",
      payload.transcript,
    ].join("\n");
  }
  return payload.transcript;
}

function extractJsonObject(source, marker) {
  const index = source.indexOf(marker);
  if (index < 0) return null;

  const start = source.indexOf("{", index + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function pickTrack(tracks, language, includeAutoCaptions) {
  const lang = language.toLowerCase();
  const langBase = lang.split("-")[0];

  const normalized = tracks
    .map((track) => {
      const languageCode = (
        track.languageCode
        || track.language_code
        || track.code
        || track.lang
        || ""
      ).toLowerCase();
      const label = (
        track.name?.simpleText
        || track.name
        || track.label
        || track.language
        || languageCode
      );
      return {
        ...track,
        languageCode,
        label: String(label || "").trim(),
        isAutoGenerated: track.kind === "asr" || track.autoGenerated === true || track.auto === true,
      };
    })
    .filter((track) => Boolean(track.baseUrl || track.url));

  const exactManual = normalized.find((track) => !track.isAutoGenerated && track.languageCode === lang);
  if (exactManual) return exactManual;

  const baseManual = normalized.find((track) => !track.isAutoGenerated && track.languageCode.startsWith(langBase));
  if (baseManual) return baseManual;

  if (includeAutoCaptions) {
    const exactAuto = normalized.find((track) => track.isAutoGenerated && track.languageCode === lang);
    if (exactAuto) return exactAuto;
    const baseAuto = normalized.find((track) => track.isAutoGenerated && track.languageCode.startsWith(langBase));
    if (baseAuto) return baseAuto;
  }

  return normalized.find((track) => !track.isAutoGenerated) || normalized[0] || null;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url,
      contentType: response.headers.get("content-type") || "",
      body: text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonBody(response, context) {
  try {
    return JSON.parse(response.body);
  } catch (err) {
    throw new Error(`Invalid JSON response from ${context}: ${err.message}`);
  }
}

function parseXmlTranscript(xml) {
  const segments = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gim;
  let match;
  while ((match = pattern.exec(xml))) {
    const attrs = match[1] || "";
    const rawText = decodeEntities(match[2] || "");
    const startMatch = attrs.match(/\bstart="([^"]+)"/i);
    const durMatch = attrs.match(/\bdur="([^"]+)"/i);
    segments.push({
      text: rawText,
      start: startMatch ? Number(startMatch[1]) : null,
      duration: durMatch ? Number(durMatch[1]) : null,
    });
  }
  return normalizeSegments(segments);
}

function parseJson3Transcript(payload) {
  const segments = [];
  for (const event of payload?.events || []) {
    if (!Array.isArray(event?.segs)) continue;
    const text = event.segs.map((seg) => seg?.utf8 || "").join("");
    segments.push({
      text,
      start: Number.isFinite(event.tStartMs) ? event.tStartMs / 1000 : null,
      duration: Number.isFinite(event.dDurationMs) ? event.dDurationMs / 1000 : null,
    });
  }
  return normalizeSegments(segments);
}

function parseVttTranscript(vtt) {
  const lines = String(vtt || "").split(/\r?\n/);
  const segments = [];
  let pendingStart = null;
  let pendingDuration = null;
  let pendingText = [];

  function flushPending() {
    if (pendingText.length === 0) return;
    segments.push({
      text: pendingText.join(" ").trim(),
      start: pendingStart,
      duration: pendingDuration,
    });
    pendingStart = null;
    pendingDuration = null;
    pendingText = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPending();
      continue;
    }
    if (/^WEBVTT/i.test(trimmed) || /^NOTE\b/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;

    const timing = trimmed.match(/^(.+?)\s*-->\s*(.+?)(\s+.+)?$/);
    if (timing) {
      flushPending();
      const start = parseTimestampToSeconds(timing[1]);
      const end = parseTimestampToSeconds(timing[2]);
      pendingStart = Number.isFinite(start) ? start : null;
      pendingDuration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
      continue;
    }

    pendingText.push(trimmed.replace(/<[^>]+>/g, ""));
  }
  flushPending();
  return normalizeSegments(segments);
}

function parseSrtTranscript(srt) {
  const blocks = String(srt || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const segments = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const timeLineIndex = /^\d+$/.test(lines[0]) ? 1 : 0;
    const timing = lines[timeLineIndex]?.match(/^(.+?)\s*-->\s*(.+)$/);
    if (!timing) continue;

    const start = parseTimestampToSeconds(timing[1]);
    const end = parseTimestampToSeconds(timing[2]);
    const textLines = lines.slice(timeLineIndex + 1);
    segments.push({
      text: textLines.join(" ").replace(/<[^>]+>/g, ""),
      start: Number.isFinite(start) ? start : null,
      duration: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
    });
  }

  return normalizeSegments(segments);
}

function parseTranscriptByFormat(body, contentType, sourceUrl = "") {
  const lowerType = String(contentType || "").toLowerCase();
  const lowerUrl = String(sourceUrl || "").toLowerCase();

  if (lowerType.includes("application/json") || lowerUrl.includes("fmt=json3") || lowerUrl.endsWith(".json3")) {
    return parseJson3Transcript(JSON.parse(body));
  }
  if (lowerType.includes("text/vtt") || lowerUrl.endsWith(".vtt")) {
    return parseVttTranscript(body);
  }
  if (lowerUrl.endsWith(".srt")) {
    return parseSrtTranscript(body);
  }
  if (body.includes("<text") && body.includes("</text>")) {
    return parseXmlTranscript(body);
  }
  if (body.includes("-->")) {
    return parseVttTranscript(body);
  }
  return normalizeSegments([{ text: body, start: null, duration: null }]);
}

function buildCaptionFetchUrls(trackUrl) {
  const urls = [];
  if (trackUrl.includes("fmt=")) {
    urls.push(trackUrl);
  } else {
    const separator = trackUrl.includes("?") ? "&" : "?";
    urls.push(`${trackUrl}${separator}fmt=json3`);
    urls.push(trackUrl);
  }
  return [...new Set(urls)];
}

function resolveAbsoluteUrl(baseUrl, maybeRelativeUrl) {
  if (!maybeRelativeUrl) return null;
  try {
    return new URL(maybeRelativeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function pickAndParseTranscriptFromPayloadCandidates(candidates, context) {
  const errors = [];
  return (async () => {
    for (const candidate of candidates) {
      try {
        const response = await fetchWithTimeout(
          context.fetchImpl,
          candidate,
          context.timeoutMs,
          { headers: context.defaultHeaders },
        );
        if (!response.ok) {
          errors.push(`HTTP ${response.status} @ ${candidate}`);
          continue;
        }
        const segments = parseTranscriptByFormat(response.body, response.contentType, candidate);
        if (segments.length > 0) {
          return segments;
        }
        errors.push(`No segments parsed @ ${candidate}`);
      } catch (err) {
        errors.push(err.message);
      }
    }
    throw new Error(errors[0] || "No transcript payload candidates succeeded");
  })();
}

async function getWatchPage(context, videoId) {
  const cacheKey = `watch:${videoId}`;
  if (context.cache.has(cacheKey)) return context.cache.get(cacheKey);

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const response = await fetchWithTimeout(context.fetchImpl, watchUrl, context.timeoutMs, {
    headers: context.defaultHeaders,
  });
  if (!response.ok) {
    throw new Error(`Watch page request failed with HTTP ${response.status}`);
  }
  context.cache.set(cacheKey, response.body);
  return response.body;
}

function extractPlayerResponseFromWatchPage(html) {
  const markers = [
    "ytInitialPlayerResponse =",
    "var ytInitialPlayerResponse =",
  ];
  for (const marker of markers) {
    const jsonText = extractJsonObject(html, marker);
    if (!jsonText) continue;
    try {
      return JSON.parse(jsonText);
    } catch {
      continue;
    }
  }
  return null;
}

function extractCaptionTracks(playerResponse) {
  return playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

async function runNsectNativeMethod(request, context) {
  const watchHtml = await getWatchPage(context, request.videoId);
  const playerResponse = extractPlayerResponseFromWatchPage(watchHtml);
  if (!playerResponse) {
    throw new Error("Could not parse ytInitialPlayerResponse");
  }

  const track = pickTrack(
    extractCaptionTracks(playerResponse),
    request.language,
    request.includeAutoCaptions,
  );
  if (!track) {
    throw new Error("No caption track found in YouTube watch payload");
  }

  const trackUrl = track.baseUrl || track.url;
  const segments = await pickAndParseTranscriptFromPayloadCandidates(
    buildCaptionFetchUrls(trackUrl),
    context,
  );

  return {
    segments,
    language: track.languageCode || request.language,
    isAutoGenerated: track.kind === "asr",
    source: "youtube/watch",
  };
}

function extractInnertubeConfig(html) {
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const versionMatch = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
  if (!keyMatch?.[1]) return null;
  return {
    apiKey: keyMatch[1],
    clientVersion: versionMatch?.[1] || "2.20240101.00.00",
  };
}

async function runNsectSignalMethod(request, context) {
  const watchHtml = await getWatchPage(context, request.videoId);
  const innertube = extractInnertubeConfig(watchHtml);
  if (!innertube) {
    throw new Error("INNERTUBE config not found on watch page");
  }

  const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(innertube.apiKey)}`;
  const response = await fetchWithTimeout(context.fetchImpl, endpoint, context.timeoutMs, {
    method: "POST",
    headers: {
      ...context.defaultHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      videoId: request.videoId,
      context: {
        client: {
          clientName: "WEB",
          clientVersion: innertube.clientVersion,
          hl: "en",
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`InnerTube player request failed with HTTP ${response.status}`);
  }

  const payload = parseJsonBody(response, "youtubei player");
  const track = pickTrack(
    extractCaptionTracks(payload),
    request.language,
    request.includeAutoCaptions,
  );
  if (!track) {
    throw new Error("No caption track found in InnerTube player payload");
  }

  const trackUrl = track.baseUrl || track.url;
  const segments = await pickAndParseTranscriptFromPayloadCandidates(
    buildCaptionFetchUrls(trackUrl),
    context,
  );

  return {
    segments,
    language: track.languageCode || request.language,
    isAutoGenerated: track.kind === "asr",
    source: "youtubei/player",
  };
}

function mapExternalTracks(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.captions)) return payload.captions;
  if (Array.isArray(payload.subtitleStreams)) return payload.subtitleStreams;
  if (Array.isArray(payload.subtitles)) return payload.subtitles;
  if (payload.url || payload.baseUrl) return [payload];
  return [];
}

async function runInvidiousMethod(request, context) {
  let lastError = null;

  for (const instance of context.invidiousInstances) {
    try {
      const indexUrl = `${instance}/api/v1/captions/${request.videoId}`;
      const response = await fetchWithTimeout(context.fetchImpl, indexUrl, context.timeoutMs, {
        headers: context.defaultHeaders,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${instance}`);
      }

      let payload;
      try {
        payload = JSON.parse(response.body);
      } catch {
        payload = null;
      }

      const track = pickTrack(
        mapExternalTracks(payload),
        request.language,
        request.includeAutoCaptions,
      );
      if (!track) {
        throw new Error("No caption entries found");
      }

      const transcriptUrl = resolveAbsoluteUrl(instance, track.url || track.baseUrl);
      if (!transcriptUrl) {
        throw new Error("Caption URL missing from Invidious payload");
      }

      const segments = await pickAndParseTranscriptFromPayloadCandidates([transcriptUrl], context);
      return {
        segments,
        language: track.languageCode || track.language_code || request.language,
        isAutoGenerated: Boolean(track.autoGenerated || track.kind === "asr"),
        source: instance,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("All Invidious instances failed");
}

async function runPipedMethod(request, context) {
  let lastError = null;

  for (const instance of context.pipedInstances) {
    try {
      const streamsUrl = `${instance}/streams/${request.videoId}`;
      const response = await fetchWithTimeout(context.fetchImpl, streamsUrl, context.timeoutMs, {
        headers: context.defaultHeaders,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${instance}`);
      }

      const payload = parseJsonBody(response, `Piped ${instance}`);
      const track = pickTrack(
        mapExternalTracks(payload),
        request.language,
        request.includeAutoCaptions,
      );
      if (!track) {
        throw new Error("No subtitle entries found in Piped payload");
      }

      const transcriptUrl = resolveAbsoluteUrl(instance, track.url || track.baseUrl);
      if (!transcriptUrl) {
        throw new Error("Subtitle URL missing from Piped payload");
      }

      const segments = await pickAndParseTranscriptFromPayloadCandidates([transcriptUrl], context);
      return {
        segments,
        language: track.languageCode || track.language_code || request.language,
        isAutoGenerated: Boolean(track.autoGenerated || track.kind === "asr"),
        source: instance,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("All Piped instances failed");
}

function collectYtDlpTracks(payload) {
  const tracks = [];

  const pushTracks = (pool, autoGenerated) => {
    for (const [languageCode, entries] of Object.entries(pool || {})) {
      for (const entry of entries || []) {
        if (!entry?.url) continue;
        tracks.push({
          languageCode: languageCode.toLowerCase(),
          url: entry.url,
          name: entry.name || languageCode,
          isAutoGenerated: autoGenerated,
        });
      }
    }
  };

  pushTracks(payload?.subtitles, false);
  pushTracks(payload?.automatic_captions, true);
  return tracks;
}

async function runYtDlpMethod(request, context) {
  let json = null;
  let lastError = null;
  const commandCandidates = context.ytDlpCommands;
  const args = [
    "--skip-download",
    "--dump-single-json",
    "--no-warnings",
    request.url,
  ];

  for (const command of commandCandidates) {
    try {
      const result = await context.execFile(command, args, {
        timeout: context.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      json = JSON.parse(result.stdout);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!json) {
    throw new Error(
      `yt-dlp unavailable (${lastError?.message || "missing binary or command failed"})`,
    );
  }

  const track = pickTrack(
    collectYtDlpTracks(json),
    request.language,
    request.includeAutoCaptions,
  );
  if (!track) {
    throw new Error("yt-dlp returned no usable subtitle URLs");
  }

  const segments = await pickAndParseTranscriptFromPayloadCandidates([track.url], context);
  return {
    segments,
    language: track.languageCode || request.language,
    isAutoGenerated: track.isAutoGenerated,
    source: "yt-dlp",
  };
}

const DEFAULT_METHOD_RUNNERS = Object.freeze({
  nsect_native: runNsectNativeMethod,
  nsect_signal: runNsectSignalMethod,
  invidious: runInvidiousMethod,
  piped: runPipedMethod,
  yt_dlp: runYtDlpMethod,
});

export async function fetchYouTubeTranscript(input, deps = {}) {
  const request = normalizeYouTubeTranscriptRequest(input);
  const startedAt = Date.now();

  const context = {
    fetchImpl: deps.fetchImpl || fetch,
    execFile: deps.execFile || execFileAsync,
    timeoutMs: request.timeoutSeconds * 1000,
    defaultHeaders: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    cache: new Map(),
    invidiousInstances: deps.invidiousInstances
      || parseListFromEnv(process.env.NSECT_INVIDIOUS_INSTANCES)
      || [...DEFAULT_INVIDIOUS_INSTANCES],
    pipedInstances: deps.pipedInstances
      || parseListFromEnv(process.env.NSECT_PIPED_INSTANCES)
      || [...DEFAULT_PIPED_INSTANCES],
    ytDlpCommands: deps.ytDlpCommands
      || parseListFromEnv(process.env.NSECT_YTDLP_COMMANDS)
      || ["yt-dlp", "yt-dlp.exe"],
  };

  const methodRunners = deps.methodRunners || DEFAULT_METHOD_RUNNERS;
  const attempts = [];

  for (const method of request.methods) {
    const runner = methodRunners[method];
    if (typeof runner !== "function") {
      attempts.push({
        method,
        status: "skipped",
        reason: "adapter_not_available",
      });
      continue;
    }

    const methodStartedAt = Date.now();
    try {
      const result = await runner(request, context);
      const segments = normalizeSegments(result?.segments || []);
      if (segments.length === 0) {
        throw new Error("adapter returned empty transcript segments");
      }

      const transcript = segmentsToText(segments);
      const payload = {
        videoId: request.videoId,
        url: request.url,
        language: result.language || request.language,
        method,
        source: result.source || null,
        autoGenerated: Boolean(result.isAutoGenerated),
        segmentCount: segments.length,
        transcript,
        segments: request.includeSegments ? segments : undefined,
      };

      attempts.push({
        method,
        status: "ok",
        reason: "ok",
        elapsedMs: Date.now() - methodStartedAt,
        segmentCount: segments.length,
      });

      return {
        success: true,
        output: formatTranscriptOutput(request.format, payload),
        meta: {
          type: "youtube_transcript",
          videoId: request.videoId,
          url: request.url,
          language: payload.language,
          method,
          source: payload.source,
          autoGenerated: payload.autoGenerated,
          segmentCount: payload.segmentCount,
          attempts,
          elapsed: ((Date.now() - startedAt) / 1000).toFixed(2),
        },
      };
    } catch (err) {
      attempts.push({
        method,
        status: "error",
        reason: err.message,
        elapsedMs: Date.now() - methodStartedAt,
      });
    }
  }

  return {
    success: false,
    output: null,
    errorCode: "TRANSCRIPT_UNAVAILABLE",
    error: "Unable to fetch transcript from all configured adapters.",
    meta: {
      type: "youtube_transcript",
      videoId: request.videoId,
      url: request.url,
      language: request.language,
      attempts,
      elapsed: ((Date.now() - startedAt) / 1000).toFixed(2),
    },
  };
}

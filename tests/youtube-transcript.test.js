import { describe, expect, it } from "vitest";
import {
  fetchYouTubeTranscript,
  normalizeYouTubeTranscriptRequest,
  parseYouTubeVideoId,
  YouTubeTranscriptValidationError,
} from "../server/core/youtube-transcript.js";

describe("YouTube transcript adapter", () => {
  it("parses YouTube IDs from direct IDs and URLs", () => {
    expect(parseYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("normalizes transcript request defaults", () => {
    const normalized = normalizeYouTubeTranscriptRequest({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(normalized.videoId).toBe("dQw4w9WgXcQ");
    expect(normalized.language).toBe("en");
    expect(normalized.methods.length).toBeGreaterThan(0);
    expect(normalized.format).toBe("text");
  });

  it("throws validation error when no video target is supplied", () => {
    expect(() => normalizeYouTubeTranscriptRequest({})).toThrow(YouTubeTranscriptValidationError);
  });

  it("falls back to the next adapter when the first one fails", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["nsect_native", "nsect_signal"],
        format: "json",
      },
      {
        methodRunners: {
          nsect_native: async () => {
            throw new Error("nsect_native blocked");
          },
          nsect_signal: async () => ({
            language: "en",
            segments: [
              { text: "Never gonna give you up", start: 0, duration: 2 },
              { text: "Never gonna let you down", start: 2, duration: 2 },
            ],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.meta.method).toBe("nsect_signal");
    expect(result.meta.attempts.map((attempt) => attempt.method)).toEqual(["nsect_native", "nsect_signal"]);
    expect(result.meta.attempts[0].status).toBe("error");
    expect(result.meta.attempts[1].status).toBe("ok");
    expect(result.output).toContain("\"method\": \"nsect_signal\"");
  });

  it("returns TRANSCRIPT_UNAVAILABLE when all adapters fail", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["nsect_native", "nsect_signal"],
      },
      {
        methodRunners: {
          nsect_native: async () => {
            throw new Error("nsect_native failed");
          },
          nsect_signal: async () => {
            throw new Error("nsect_signal failed");
          },
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("TRANSCRIPT_UNAVAILABLE");
    expect(result.meta.attempts).toHaveLength(2);
    expect(result.meta.attempts.every((attempt) => attempt.status === "error")).toBe(true);
  });

  it("skips adapters that return empty segments", async () => {
    const result = await fetchYouTubeTranscript(
      { videoId: "dQw4w9WgXcQ", methods: ["nsect_native", "nsect_signal"] },
      {
        methodRunners: {
          nsect_native: async () => ({ segments: [] }),
          nsect_signal: async () => ({ segments: [{ text: "Real text", start: 0, duration: 1 }] }),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.meta.method).toBe("nsect_signal");
    expect(result.meta.attempts[0].status).toBe("error");
  });

  it("handles adapter returning null segments gracefully", async () => {
    const result = await fetchYouTubeTranscript(
      { videoId: "dQw4w9WgXcQ", methods: ["nsect_native", "nsect_signal"] },
      {
        methodRunners: {
          nsect_native: async () => ({ segments: null }),
          nsect_signal: async () => ({ segments: [{ text: "ok", start: 0, duration: 1 }] }),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.meta.method).toBe("nsect_signal");
  });

  it("handles adapter returning undefined gracefully", async () => {
    const result = await fetchYouTubeTranscript(
      { videoId: "dQw4w9WgXcQ", methods: ["nsect_native"] },
      {
        methodRunners: {
          nsect_native: async () => undefined,
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("TRANSCRIPT_UNAVAILABLE");
  });

  it("respects includeSegments flag in output", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["nsect_signal"],
        format: "json",
        includeSegments: true,
      },
      {
        methodRunners: {
          nsect_signal: async () => ({
            language: "en",
            segments: [
              { text: "Segment 1", start: 0, duration: 1 },
              { text: "Segment 2", start: 1, duration: 1 },
            ],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    const output = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
    expect(output.segments).toBeDefined();
    expect(output.segments).toHaveLength(2);
  });

  it("omits segments when includeSegments is false", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["nsect_signal"],
        format: "json",
        includeSegments: false,
      },
      {
        methodRunners: {
          nsect_signal: async () => ({
            language: "en",
            segments: [{ text: "Text", start: 0, duration: 1 }],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    const output = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
    expect(output.segments).toBeUndefined();
  });

  it("formats output as markdown when requested", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["nsect_signal"],
        format: "markdown",
      },
      {
        methodRunners: {
          nsect_signal: async () => ({
            language: "en",
            segments: [{ text: "Hello world", start: 0, duration: 1 }],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("# Transcript: dQw4w9WgXcQ");
    expect(result.output).toContain("Hello world");
  });

  it("records elapsed time per adapter in attempts", async () => {
    const result = await fetchYouTubeTranscript(
      { videoId: "dQw4w9WgXcQ", methods: ["nsect_signal"] },
      {
        methodRunners: {
          nsect_signal: async () => ({
            language: "en",
            segments: [{ text: "ok", start: 0, duration: 1 }],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.meta.attempts[0].elapsedMs).toBeDefined();
    expect(typeof result.meta.attempts[0].elapsedMs).toBe("number");
  });

  it("rejects unknown adapter method names at validation time", async () => {
    await expect(
      fetchYouTubeTranscript(
        { videoId: "dQw4w9WgXcQ", methods: ["nonexistent_method"] },
        {},
      ),
    ).rejects.toThrow(YouTubeTranscriptValidationError);
  });

  it("skips adapters without a runner function (method not available)", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["nsect_native", "nsect_signal"],
      },
      {
        // Provide only one runner — nsect_native has no runner and should be skipped
        methodRunners: {
          nsect_signal: async () => ({
            language: "en",
            segments: [{ text: "ok", start: 0, duration: 1 }],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    // nsect_native should be skipped (no runner), nsect_signal should succeed
    const nativeAttempt = result.meta.attempts.find((a) => a.method === "nsect_native");
    expect(nativeAttempt.status).toBe("skipped");
    expect(nativeAttempt.reason).toBe("adapter_not_available");
  });

  it("respects custom methods order (first working wins)", async () => {
    const result = await fetchYouTubeTranscript(
      {
        videoId: "dQw4w9WgXcQ",
        methods: ["yt_dlp", "nsect_signal"],
        format: "json",
      },
      {
        methodRunners: {
          yt_dlp: async () => ({
            language: "en",
            segments: [{ text: "from yt_dlp", start: 0, duration: 1 }],
            source: "yt-dlp",
          }),
          nsect_signal: async () => ({
            language: "en",
            segments: [{ text: "from signal", start: 0, duration: 1 }],
          }),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.meta.method).toBe("yt_dlp");
    expect(result.meta.attempts).toHaveLength(1);
  });
});

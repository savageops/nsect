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
});

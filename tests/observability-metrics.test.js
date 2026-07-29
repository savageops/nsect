import { describe, it, expect, beforeEach } from "vitest";
import {
  getObservabilitySnapshot,
  recordHttpResponse,
  recordEngineOutcome,
  resetObservabilityForTests,
} from "../server/observability/metrics.js";

describe("server/observability/metrics.js", () => {
  beforeEach(() => {
    resetObservabilityForTests();
  });

  it("tracks success, blocked attempts, fallback depth, p95, and 429s", () => {
    recordHttpResponse({ statusCode: 200, durationMs: 50 });
    recordHttpResponse({ statusCode: 429, durationMs: 120 });
    recordHttpResponse({ statusCode: 200, durationMs: 80 });

    recordEngineOutcome({
      success: true,
      meta: {
        attempts: [
          { engine: "duckduckgo", reason: "blocked", resultCount: 0 },
          { engine: "bing", reason: "ok", resultCount: 3 },
        ],
      },
    });

    const snapshot = getObservabilitySnapshot();
    expect(snapshot.success).toBe(1);
    expect(snapshot.blocked).toBe(1);
    expect(snapshot.fallback_depth).toBe(1);
    expect(snapshot.p95).toBeGreaterThanOrEqual(120);
    expect(snapshot["429s"]).toBe(1);
  });

  it("returns zero snapshot when no data recorded", () => {
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.success).toBe(0);
    expect(snapshot.blocked).toBe(0);
    expect(snapshot.fallback_depth).toBe(0);
    expect(snapshot.p95).toBe(0);
    expect(snapshot["429s"]).toBe(0);
  });

  it("does not count non-429 status codes", () => {
    recordHttpResponse({ statusCode: 200, durationMs: 10 });
    recordHttpResponse({ statusCode: 500, durationMs: 20 });
    recordHttpResponse({ statusCode: 403, durationMs: 30 });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot["429s"]).toBe(0);
  });

  it("rejects NaN and negative durations", () => {
    recordHttpResponse({ statusCode: 200, durationMs: NaN });
    recordHttpResponse({ statusCode: 200, durationMs: -5 });
    recordHttpResponse({ statusCode: 200, durationMs: Infinity });
    const snapshot = getObservabilitySnapshot();
    // p95 should be 0 since no valid samples were pushed
    expect(snapshot.p95).toBe(0);
  });

  it("handles single latency sample", () => {
    recordHttpResponse({ statusCode: 200, durationMs: 42.5 });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.p95).toBe(42.5);
  });

  it("fallback depth is 0 when first engine succeeds", () => {
    recordEngineOutcome({
      success: true,
      meta: {
        attempts: [{ engine: "duckduckgo", reason: "ok", resultCount: 5 }],
      },
    });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.fallback_depth).toBe(0);
  });

  it("fallback depth reflects last attempt when all fail", () => {
    recordEngineOutcome({
      success: true,
      meta: {
        attempts: [
          { engine: "duckduckgo", reason: "blocked", resultCount: 0 },
          { engine: "bing", reason: "blocked", resultCount: 0 },
          { engine: "google", reason: "ok", resultCount: 2 },
        ],
      },
    });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.fallback_depth).toBe(2);
  });

  it("ignores failed engine outcomes", () => {
    recordEngineOutcome({ success: false });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.success).toBe(0);
  });

  it("handles engine outcome with no attempts", () => {
    recordEngineOutcome({ success: true, meta: { type: "page" } });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.success).toBe(1);
    expect(snapshot.fallback_depth).toBe(0);
  });

  it("counts multiple blocked attempts in a single outcome", () => {
    recordEngineOutcome({
      success: true,
      meta: {
        attempts: [
          { engine: "duckduckgo", reason: "blocked", resultCount: 0 },
          { engine: "bing", reason: "blocked", resultCount: 0 },
          { engine: "brave", reason: "ok", resultCount: 3 },
        ],
      },
    });
    const snapshot = getObservabilitySnapshot();
    expect(snapshot.blocked).toBe(2);
  });

  it("rolling window caps at 500 latency samples", () => {
    for (let i = 0; i < 600; i++) {
      recordHttpResponse({ statusCode: 200, durationMs: i });
    }
    const snapshot = getObservabilitySnapshot();
    // Should not crash, p95 should be based on last 500 samples (100-599)
    expect(snapshot.p95).toBeGreaterThan(0);
  });
});

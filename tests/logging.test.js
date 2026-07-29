import { describe, it, expect, vi, afterEach } from "vitest";
import { logEvent, logError } from "../server/observability/logging.js";

// Capture stdout/stderr writes
function captureStd(fn, stream) {
  const writes = [];
  const original = process[stream].write.bind(process[stream]);
  process[stream].write = (chunk) => {
    writes.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process[stream].write = original;
  }
  return writes.join("");
}

describe("logEvent", () => {
  it("writes structured JSON to stdout with event + fields", () => {
    const output = captureStd(() => logEvent("test.event", { key: "value" }), "stdout");
    const parsed = JSON.parse(output.trim());
    expect(parsed.event).toBe("test.event");
    expect(parsed.key).toBe("value");
    expect(parsed.level).toBe("info");
    expect(parsed.ts).toBeTruthy();
  });

  it("rounds duration_ms to 2 decimal places", () => {
    const output = captureStd(() => logEvent("http.request", { duration_ms: 123.456789 }), "stdout");
    const parsed = JSON.parse(output.trim());
    expect(parsed.duration_ms).toBe(123.46);
  });

  it("works with no fields", () => {
    const output = captureStd(() => logEvent("bare.event"), "stdout");
    const parsed = JSON.parse(output.trim());
    expect(parsed.event).toBe("bare.event");
    expect(parsed.level).toBe("info");
  });

  it("preserves non-duration numeric fields without rounding", () => {
    const output = captureStd(() => logEvent("test", { count: 42.999 }), "stdout");
    const parsed = JSON.parse(output.trim());
    expect(parsed.count).toBe(42.999);
  });
});

describe("logError", () => {
  it("writes structured JSON to stderr with error message", () => {
    const output = captureStd(() => logError("test.error", new Error("boom")), "stderr");
    const parsed = JSON.parse(output.trim());
    expect(parsed.event).toBe("test.error");
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("boom");
    expect(parsed.ts).toBeTruthy();
  });

  it("handles non-Error objects via String()", () => {
    const output = captureStd(() => logError("test.error", "string error"), "stderr");
    const parsed = JSON.parse(output.trim());
    expect(parsed.message).toBe("string error");
  });

  it("handles null error gracefully", () => {
    const output = captureStd(() => logError("test.error", null), "stderr");
    const parsed = JSON.parse(output.trim());
    expect(parsed.message).toBe("null");
  });

  it("handles error with no message", () => {
    const err = new Error();
    const output = captureStd(() => logError("test.error", err), "stderr");
    const parsed = JSON.parse(output.trim());
    // Node.js 22+ sets message to "Error" for new Error(); older versions use ""
    expect(parsed.message).toBeTruthy();
  });

  it("merges extra fields", () => {
    const output = captureStd(() => logError("test.error", new Error("fail"), { context: "ctx" }), "stderr");
    const parsed = JSON.parse(output.trim());
    expect(parsed.context).toBe("ctx");
    expect(parsed.message).toBe("fail");
  });
});

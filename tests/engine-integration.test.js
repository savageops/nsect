import { describe, it, expect } from "vitest";
import { runNsectEngine } from "../server/core/engine.js";

const itLive = process.env.LIVE_INTEGRATION === "1" ? it : it.skip;

describe("core nsect engine (integration)", () => {
  it("throws error for missing url and google", async () => {
    await expect(runNsectEngine({
      method: "direct",
      format: "text",
      timeout: 5,
    })).rejects.toThrow(/url.*google.*required/i);
  });

  itLive("scrapes example.com with method=direct, format=text", async () => {
    const result = await runNsectEngine({
      url: "https://example.com",
      method: "direct",
      format: "text",
      timeout: 15,
    });

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
    expect(result.output.toLowerCase()).toMatch(/example domain/);
    expect(result.meta.type).toBe("page");
  }, 30000);

  itLive("runs fallback search and keeps google last", async () => {
    const result = await runNsectEngine({
      query: "example domain",
      format: "json",
      googleCount: 3,
      timeout: 15,
    });

    expect(result.success).toBe(true);
    expect(result.meta.type).toBe("search");
    expect(Array.isArray(result.meta.engineOrder)).toBe(true);
    expect(result.meta.engineOrder.at(-1)).toBe("google");
  }, 30000);
});

import { describe, expect, it } from "vitest";
import {
  MCP_CONFIG_EXAMPLE,
  createApiClient,
  readMcpConfig,
} from "../packages/mcp/api-client.js";
import { ENGINE_API_PATH } from "../server/core/contracts.js";

describe("packages/mcp/api-client", () => {
  it("reads env config with defaults", () => {
    const config = readMcpConfig({
      NSECT_API_KEY: "sk_test",
    });

    expect(config.apiBase).toBe("http://localhost:3000");
    expect(config.apiKey).toBe("sk_test");
    expect(MCP_CONFIG_EXAMPLE.mcpServers.nsect).toBeTruthy();
  });

  it("does not read removed legacy env aliases", () => {
    const config = readMcpConfig({
      STEALTH_SCRAPER_URL: "https://legacy.example",
      STEALTH_SCRAPER_API_KEY: "legacy_key",
    });

    expect(config.apiBase).toBe("http://localhost:3000");
    expect(config.apiKey).toBe("");
  });

  it("returns ok payload for successful API responses", async () => {
    const client = createApiClient({
      apiBase: "http://localhost:3000",
      apiKey: "sk_test",
      fetchImpl: async () => new Response(
        JSON.stringify({ success: true, output: "ok" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const result = await client.postJson(ENGINE_API_PATH, { url: "https://example.com" });
    expect(result.ok).toBe(true);
    expect(result.payload.success).toBe(true);
  });

  it("returns structured API error for non-2xx json response", async () => {
    const client = createApiClient({
      apiBase: "http://localhost:3000",
      apiKey: "sk_test",
      fetchImpl: async () => new Response(
        JSON.stringify({ error: "bad key" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    });

    const result = await client.postJson(ENGINE_API_PATH, {});
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/API Error 403/);
    expect(result.errorMessage).toMatch(/bad key/);
  });

  it("handles non-json error responses", async () => {
    const client = createApiClient({
      apiBase: "http://localhost:3000",
      apiKey: "sk_test",
      fetchImpl: async () => new Response("upstream unavailable", { status: 502 }),
    });

    const result = await client.postJson(ENGINE_API_PATH, {});
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/upstream unavailable/);
  });

  it("handles thrown network errors", async () => {
    const client = createApiClient({
      apiBase: "http://localhost:3000",
      apiKey: "sk_test",
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      },
    });

    const result = await client.postJson(ENGINE_API_PATH, {});
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/ENOTFOUND/);
  });

  it("handles timeout aborts", async () => {
    const client = createApiClient({
      apiBase: "http://localhost:3000",
      apiKey: "sk_test",
      timeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      }),
    });

    const result = await client.postJson(ENGINE_API_PATH, {});
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/timed out/i);
  });

  it("omits the x-api-key header when no key is configured (local mode)", async () => {
    let capturedHeaders;
    const client = createApiClient({
      apiBase: "http://localhost:3000",
      apiKey: "",
      fetchImpl: async (_url, init) => {
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.postJson(ENGINE_API_PATH, {});
    expect(result.ok).toBe(true);
    expect(capturedHeaders).not.toHaveProperty("x-api-key");
  });
});

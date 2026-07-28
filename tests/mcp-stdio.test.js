import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MCP_ENTRY = resolve(process.cwd(), "packages", "mcp", "index.js");

function collectUntilClose(child) {
  return new Promise((resolveResult) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolveResult({ code, stderr });
    });
  });
}

function waitForStderr(child, pattern, timeoutMs = 5000) {
  return new Promise((resolveResult, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for stderr pattern: ${pattern}`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      if (pattern.test(buffer)) {
        clearTimeout(timeout);
        resolveResult(buffer);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("MCP stdio server", () => {
  it("starts in keyless (local) mode when NSECT_API_KEY is missing", async () => {
    // Local mode contract: a missing key is not fatal. The server warns to
    // stderr and continues running so it can talk to a keyless local server.
    const child = spawn(process.execPath, [MCP_ENTRY], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NSECT_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const closePromise = collectUntilClose(child);
    await waitForStderr(child, /keyless/i, 10000);
    // Must still reach the running banner (did not exit).
    await waitForStderr(child, /running on stdio/i, 10000);
    child.kill();

    const result = await closePromise;
    expect(result.stderr).toMatch(/keyless/i);
    expect(result.stderr).toMatch(/running on stdio/i);
  }, 15000);

  it("starts successfully when required env vars are set", async () => {
    const child = spawn(process.execPath, [MCP_ENTRY], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NSECT_API_KEY: "sk_test",
        NSECT_API_URL: "http://127.0.0.1:3000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const closePromise = collectUntilClose(child);
    await waitForStderr(child, /running on stdio/i, 10000);
    child.kill();

    const result = await closePromise;
    expect(result.stderr).toMatch(/running on stdio/i);
  }, 15000);
});

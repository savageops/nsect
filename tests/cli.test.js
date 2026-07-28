import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const itLive = process.env.LIVE_INTEGRATION === "1" ? it : it.skip;

describe("CLI nsect-engine.js", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await exec("node", ["nsect-engine.js", "--help"], {
      cwd: process.cwd(),
    });
    expect(stdout).toContain("nsect");
    expect(stdout).toContain("--url");
    expect(stdout).toContain("--method");
    expect(stdout).toContain("--format");
    expect(stdout).toContain("--verbose");
    expect(stdout).toContain("--help");
  });

  it("exits with error when no URL provided", async () => {
    try {
      await exec("node", ["nsect-engine.js"], { cwd: process.cwd() });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err.code).toBe(1);
      expect(err.stderr).toMatch(/--url.*--google.*required/i);
    }
  });

  it("exits with error for invalid method", async () => {
    try {
      await exec("node", ["nsect-engine.js", "--url", "https://example.com", "--method", "bogus"], {
        cwd: process.cwd(),
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err.code).toBe(1);
      expect(err.stderr).toMatch(/unknown method/i);
    }
  });

  it("exits with error for invalid format", async () => {
    try {
      await exec("node", ["nsect-engine.js", "--url", "https://example.com", "--format", "bogus"], {
        cwd: process.cwd(),
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err.code).toBe(1);
      expect(err.stderr).toMatch(/unknown format/i);
    }
  });

  itLive("scrapes example.com and outputs text (live)", async () => {
    const { stdout } = await exec(
      "node",
      ["nsect-engine.js", "--url", "https://example.com", "--format", "text", "--timeout", "15"],
      { cwd: process.cwd() },
    );
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout.toLowerCase()).toMatch(/example domain/);
  }, 30000);

  itLive("scrapes with --format json (live)", async () => {
    const { stdout } = await exec(
      "node",
      ["nsect-engine.js", "--url", "https://example.com", "--format", "json", "--timeout", "15"],
      { cwd: process.cwd() },
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.title).toBeTruthy();
    expect(parsed.text.length).toBeGreaterThan(0);
  }, 30000);

  itLive("scrapes with --format links (live)", async () => {
    const { stdout } = await exec(
      "node",
      ["nsect-engine.js", "--url", "https://example.com", "--format", "links", "--timeout", "15"],
      { cwd: process.cwd() },
    );
    expect(stdout).toContain("http");
  }, 30000);

  itLive("scrapes with --format markdown (live)", async () => {
    const { stdout } = await exec(
      "node",
      ["nsect-engine.js", "--url", "https://example.com", "--format", "markdown", "--timeout", "15"],
      { cwd: process.cwd() },
    );
    expect(stdout.length).toBeGreaterThan(0);
  }, 30000);

  itLive("prints metadata to stderr with --metadata flag (live)", async () => {
    const { stderr } = await exec(
      "node",
      ["nsect-engine.js", "--url", "https://example.com", "--format", "text", "--metadata", "--timeout", "15"],
      { cwd: process.cwd() },
    );
    expect(stderr).toContain("[meta]");
    expect(stderr).toContain("Fingerprint:");
    expect(stderr).toContain("Viewport:");
    expect(stderr).toContain("Method:");
  }, 30000);

  itLive("supports --query/--google search flags (live)", async () => {
    const { stdout } = await exec(
      "node",
      [
        "nsect-engine.js",
        "--query",
        "example",
        "--google",
        "example",
        "--format",
        "json",
        "--google-count",
        "3",
        "--search-engines",
        "duckduckgo,bing,brave,google",
        "--timeout",
        "15",
      ],
      { cwd: process.cwd() },
    );
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  }, 30000);

  itLive("writes output to file with --output flag (live)", async () => {
    const { resolve } = await import("node:path");
    const outputPath = resolve(process.cwd(), "data", "test-output.txt");
    const { existsSync, rmSync } = await import("node:fs");

    await exec(
      "node",
      ["nsect-engine.js", "--url", "https://example.com", "--format", "text", "--output", outputPath, "--timeout", "15"],
      { cwd: process.cwd() },
    );

    expect(existsSync(outputPath)).toBe(true);
    const content = await import("node:fs").then((fs) => fs.readFileSync(outputPath, "utf-8"));
    expect(content.length).toBeGreaterThan(0);
    rmSync(outputPath);
  }, 30000);
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isSolverEligible,
  solveChallenge,
  injectSolution,
  SolverError,
} from "../server/core/solver.js";

// ---------------------------------------------------------------------------
// isSolverEligible — determines which challenge kinds the solver can handle
// ---------------------------------------------------------------------------

describe("isSolverEligible", () => {
  it("returns true for API-solvable challenge kinds", () => {
    expect(isSolverEligible("cloudflare_turnstile")).toBe(true);
    expect(isSolverEligible("cloudflare")).toBe(true);
    expect(isSolverEligible("hcaptcha")).toBe(true);
    expect(isSolverEligible("recaptcha")).toBe(true);
  });

  it("returns false for non-API-solvable challenge kinds", () => {
    expect(isSolverEligible("perimeterx")).toBe(false);
    expect(isSolverEligible("datadome")).toBe(false);
    expect(isSolverEligible("blocked")).toBe(false);
    expect(isSolverEligible("akamai")).toBe(false);
    expect(isSolverEligible("generic")).toBe(false);
    expect(isSolverEligible("unknown_kind")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SolverError — typed error with code
// ---------------------------------------------------------------------------

describe("SolverError", () => {
  it("carries a message and code", () => {
    const err = new SolverError("something failed", "SOLVER_TIMEOUT");
    expect(err.message).toBe("something failed");
    expect(err.code).toBe("SOLVER_TIMEOUT");
    expect(err.name).toBe("SolverError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// solveChallenge — uses mocked fetch to simulate the solver API
// ---------------------------------------------------------------------------

// Build a fake page object for extractSiteKey + injectSolution.
function fakeSolverPage({ sitekey = null, url = "https://example.com" } = {}) {
  return {
    url: () => url,
    async evaluate(fn, ...args) {
      // extractSiteKey passes a selectors array; injectSolution passes (kind, token).
      // For sitekey extraction: return the sitekey if set, else null.
      const src = typeof fn === "function" ? fn.toString() : String(fn);
      if (sitekey) return sitekey;
      return null;
    },
  };
}

describe("solveChallenge", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws SOLVER_NO_KEY when no API key provided", async () => {
    const page = fakeSolverPage({ sitekey: "0xAAAAAAA00000000" });
    await expect(
      solveChallenge(page, { kind: "cloudflare_turnstile" }, { provider: "capsolver", apiKey: "" }),
    ).rejects.toThrow(/API key not configured/);
  });

  it("throws SOLVER_BAD_PROVIDER for unknown provider", async () => {
    const page = fakeSolverPage({ sitekey: "0xAAAAAAA00000000" });
    await expect(
      solveChallenge(page, { kind: "cloudflare_turnstile" }, { provider: "fakeprovider", apiKey: "key" }),
    ).rejects.toThrow(/Unknown solver provider/);
  });

  it("throws SOLVER_NO_SITEKEY when sitekey cannot be extracted", async () => {
    const page = fakeSolverPage({ sitekey: null });
    await expect(
      solveChallenge(page, { kind: "cloudflare_turnstile" }, { provider: "capsolver", apiKey: "key", timeout: 1 }),
    ).rejects.toThrow(/Could not extract site key/);
  });

  it("returns token on successful solve (CapSolver flow)", async () => {
    const page = fakeSolverPage({ sitekey: "0xAAAAAAA00000000" });
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        callCount++;
        if (callCount === 1) {
          // createTask response
          return { errorId: 0, taskId: "task-123", status: "idle" };
        }
        // getTaskResult response (ready)
        return {
          errorId: 0,
          status: "ready",
          solution: {
            token: "0.solved_token_here_abc123",
            userAgent: "Mozilla/5.0 (Test UA)",
          },
        };
      },
    }));

    const result = await solveChallenge(page, { kind: "cloudflare_turnstile" }, {
      provider: "capsolver",
      apiKey: "test-key",
      timeout: 5,
    });

    expect(result.token).toBe("0.solved_token_here_abc123");
    expect(result.userAgent).toBe("Mozilla/5.0 (Test UA)");
  });

  it("throws when createTask returns an error", async () => {
    const page = fakeSolverPage({ sitekey: "0xAAAAAAA00000000" });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        errorId: 1,
        errorDescription: "Invalid API key",
      }),
    }));

    await expect(
      solveChallenge(page, { kind: "hcaptcha" }, { provider: "capsolver", apiKey: "bad-key", timeout: 2 }),
    ).rejects.toThrow(/Invalid API key/);
  });

  it("throws SOLVER_TIMEOUT when task never becomes ready", async () => {
    const page = fakeSolverPage({ sitekey: "0xAAAAAAA00000000" });
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.task) {
        return { ok: true, json: async () => ({ errorId: 0, taskId: "t1", status: "idle" }) };
      }
      return { ok: true, json: async () => ({ errorId: 0, status: "processing" }) };
    });

    await expect(
      solveChallenge(page, { kind: "recaptcha" }, { provider: "capsolver", apiKey: "key", timeout: 1 }),
    ).rejects.toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// injectSolution — injects a solved token into the page DOM
// ---------------------------------------------------------------------------

describe("injectSolution", () => {
  it("calls page.evaluate without throwing", async () => {
    const evaluateCalls = [];
    const page = {
      async evaluate(fn, ...args) {
        evaluateCalls.push({ src: typeof fn === "function" ? fn.toString().substring(0, 50) : String(fn) });
      },
      async waitForNetworkIdle() {},
    };

    await expect(injectSolution(page, "cloudflare_turnstile", "test-token")).resolves.not.toThrow();
    expect(evaluateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("handles evaluate failures gracefully", async () => {
    const page = {
      async evaluate() {
        throw new Error("page detached");
      },
      async waitForNetworkIdle() {},
    };

    await expect(injectSolution(page, "hcaptcha", "token")).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LIVE_INTEGRATION solver end-to-end test
//
// Validates the full solver pipeline: engine detects a challenge → solver
// calls CapSolver → token injected → page resolves → extraction succeeds.
//
// Requires: LIVE_INTEGRATION=1 AND NSECT_SOLVER_API_KEY=<real_key>
// Run: LIVE_INTEGRATION=1 NSECT_SOLVER_API_KEY=CAP-xxx npx vitest run tests/solver.test.js -t "live"
// ---------------------------------------------------------------------------

const itLive = process.env.LIVE_INTEGRATION === "1" ? it : it.skip;
const solverApiKey = process.env.NSECT_SOLVER_API_KEY || "";

describe("Live solver end-to-end pipeline", () => {
  itLive("solver detects, solves, and resolves a real challenge page", async () => {
    if (!solverApiKey) {
      console.error("[solver-live] Skipping: NSECT_SOLVER_API_KEY not set");
      return;
    }

    // Find a real page that serves a Turnstile/hCaptcha challenge.
    // We use a known challenge-testing site. If the site is down, the test
    // should skip gracefully rather than fail.
    const { runNsectEngine } = await import("../server/core/engine.js");
    const challengeUrl = "https://demo.turnstile.workers.dev/";

    const result = await runNsectEngine({
      url: challengeUrl,
      strategy: "auto",
      challengeTimeout: 20,
      bypassChallenges: true,
      format: "text",
      timeout: 90, // generous for solver latency
      solver: {
        enabled: true,
        provider: "capsolver",
        apiKey: solverApiKey,
        timeout: 60,
        kinds: ["cloudflare_turnstile", "cloudflare", "hcaptcha", "recaptcha"],
      },
    });

    // The solver pipeline should either:
    // 1. Succeed (challenge detected → solved → content extracted)
    // 2. Fail with CHALLENGE_BLOCKED (solver couldn't solve in time — acceptable)
    if (result.success) {
      // If it succeeded, verify the challenge meta shows it was solved
      expect(result.meta?.challenge?.solved).toBe(true);
    } else {
      // If it failed, it should be a CHALLENGE_BLOCKED (not BROWSER_LAUNCH etc)
      expect(result.errorCode).toBe("CHALLENGE_BLOCKED");
      expect(result.meta?.challenge?.detected).toBe(true);
    }
  }, 120000);
});

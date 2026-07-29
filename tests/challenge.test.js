import { describe, it, expect, vi } from "vitest";
import {
  detectChallenge,
  waitForChallengeResolution,
  hasSubstantiveContent,
  detectInfiniteScroll,
  DEFAULT_CHALLENGE_TIMEOUT_MS,
} from "../server/core/challenge.js";

/**
 * Build a fake puppeteer Page with stubbed url()/evaluate() returning
 * deterministic challenge content. Lets us unit-test the signature matcher
 * without launching a browser.
 */
function fakePage({ url = "https://example.com", text = "", markers = [], title: pageTitle = "Example Page" } = {}) {
  return {
    url: () => url,
    title: async () => pageTitle,
    async evaluate(fn, ...args) {
      if (typeof fn === "function") {
        const src = fn.toString();
        if (src.includes("innerText")) {
          if (src.includes(">= min")) {
            const [min] = args;
            return text.trim().length >= min;
          }
          return text.substring(0, 12_000);
        }
        if (src.includes("querySelectorAll") || src.includes("querySelector")) {
          if (src.includes("scrollHeight")) {
            return detectInfiniteScrollFake(markers);
          }
          return markers;
        }
      }
      return undefined;
    },
  };
}

// Simplified infinite-scroll heuristic for the fake page: true if a feed
// sentinel is among the markers.
function detectInfiniteScrollFake(markers) {
  return markers.includes("[role='feed']");
}

describe("detectChallenge", () => {
  it("returns null for clean page content", async () => {
    const page = fakePage({
      url: "https://example.com/article",
      text: "This is a normal article with substantial body text about a real topic.",
    });
    expect(await detectChallenge(page)).toBeNull();
  });

  it("detects Cloudflare by DOM marker", async () => {
    const page = fakePage({
      url: "https://protected.com/",
      text: "Just a moment...",
      markers: ["#cf-challenge"],
    });
    const result = await detectChallenge(page);
    expect(result.kind).toBe("cloudflare");
    expect(result.autoResolvable).toBe(true);
  });

  it("detects Cloudflare by text pattern alone", async () => {
    const page = fakePage({
      url: "https://protected.com/",
      text: "Checking your browser before accessing the site. Please wait.",
    });
    const result = await detectChallenge(page);
    expect(result.kind).toBe("cloudflare");
  });

  it("detects hCaptcha and marks it NOT auto-resolvable", async () => {
    const page = fakePage({
      url: "https://captcha-protected.com/",
      text: "Please complete the hcaptcha",
      markers: ["iframe[src*='hcaptcha']"],
    });
    const result = await detectChallenge(page);
    expect(result.kind).toBe("hcaptcha");
    expect(result.autoResolvable).toBe(false);
  });

  it("detects DataDome challenge", async () => {
    const page = fakePage({
      url: "https://dd-protected.com/",
      text: "please verify you are a person (datadome)",
    });
    const result = await detectChallenge(page);
    expect(result.kind).toBe("datadome");
    expect(result.autoResolvable).toBe(true);
  });

  it("detects hard blocks as non-resolvable", async () => {
    const page = fakePage({
      url: "https://blocked.com/sorry/index",
      text: "Our systems have detected unusual traffic from your computer.",
    });
    const result = await detectChallenge(page);
    expect(result.kind).toBe("blocked");
    expect(result.autoResolvable).toBe(false);
  });

  it("detects reCAPTCHA", async () => {
    const page = fakePage({
      url: "https://protected.com/",
      text: "I'm not a robot",
      markers: [".g-recaptcha"],
    });
    const result = await detectChallenge(page);
    expect(result.kind).toBe("recaptcha");
    expect(result.autoResolvable).toBe(false);
  });

  it("detects empty-page PX/imperva block by bare-hostname title + no text", async () => {
    // The Yelp-style block: zero body text, title equals bare hostname.
    const page = fakePage({
      url: "https://www.yelp.com/biz/some-business",
      text: "",
      title: "yelp.com",
      markers: [],
    });
    const result = await detectChallenge(page);
    expect(result).not.toBeNull();
    expect(result.kind).toBe("blocked");
    expect(result.autoResolvable).toBe(false);
  });

  it("does NOT false-positive on a short-content page with a real title", async () => {
    // A legitimate page with brief content but a descriptive title must not be
    // flagged as a block.
    const page = fakePage({
      url: "https://example.com/status",
      text: "OK",
      title: "Service Status",
      markers: [],
    });
    const result = await detectChallenge(page);
    expect(result).toBeNull();
  });

  it("does NOT false-positive on a canvas/image-only page with empty text", async () => {
    // A WebGL app, PDF.js viewer, or image-only page has zero innerText but
    // contains canvas/img/iframe — must not be flagged as a bot block.
    const page = fakePage({
      url: "https://example.com/viewer",
      text: "",
      title: "example.com",
      markers: ["canvas"],
    });
    const result = await detectChallenge(page);
    expect(result).toBeNull();
  });
});

describe("waitForChallengeResolution", () => {
  it("returns immediately when no challenge is detected", async () => {
    const page = fakePage({ text: "Normal content" });
    const result = await waitForChallengeResolution(page, { timeoutMs: 100 });
    expect(result.detected).toBe(false);
    expect(result.resolved).toBe(true);
    expect(result.waitedMs).toBe(0);
  });

  it("fails fast on interactive challenges (no budget burned)", async () => {
    const page = fakePage({
      text: "hcaptcha",
      markers: ["iframe[src*='hcaptcha']"],
    });
    const result = await waitForChallengeResolution(page, { timeoutMs: 5000 });
    expect(result.detected).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.interactive).toBe(true);
    expect(result.waitedMs).toBe(0);
  });

  it("reports auto-resolution when challenge clears within budget", async () => {
    // Simulate a challenge that clears after 2 polls: first detect returns
    // cloudflare, subsequent detects return null.
    let callCount = 0;
    const page = {
      url: () => "https://cf.com/",
      async title() { return "Real Article Title"; },
      async evaluate() {
        callCount += 1;
        if (callCount <= 1) return "Just a moment..."; // challenge text
        return "Real article content here."; // cleared
      },
    };
    const result = await waitForChallengeResolution(page, {
      timeoutMs: 5000,
      pollIntervalMs: 10,
    });
    expect(result.detected).toBe(true);
    expect(result.kind).toBe("cloudflare");
    expect(result.resolved).toBe(true);
    expect(result.waitedMs).toBeGreaterThan(0);
  });

  it("reports timedOut when auto-resolvable challenge doesn't clear", async () => {
    const page = fakePage({
      url: "https://cf.com/",
      text: "Just a moment...",
      markers: ["#cf-challenge"],
    });
    const result = await waitForChallengeResolution(page, {
      timeoutMs: 30,
      pollIntervalMs: 10,
    });
    expect(result.detected).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe("hasSubstantiveContent", () => {
  it("returns true for content above the threshold", async () => {
    const page = fakePage({ text: "x".repeat(300) });
    expect(await hasSubstantiveContent(page)).toBe(true);
  });

  it("returns false for near-empty content", async () => {
    const page = fakePage({ text: "tiny" });
    expect(await hasSubstantiveContent(page)).toBe(false);
  });
});

describe("detectInfiniteScroll", () => {
  it("returns true when feed sentinel is present", async () => {
    const page = fakePage({ markers: ["[role='feed']"] });
    expect(await detectInfiniteScroll(page)).toBe(true);
  });
});

describe("DEFAULT_CHALLENGE_TIMEOUT_MS", () => {
  it("is 15 seconds (generous for CF/DataDome, bounded)", () => {
    expect(DEFAULT_CHALLENGE_TIMEOUT_MS).toBe(15_000);
  });
});

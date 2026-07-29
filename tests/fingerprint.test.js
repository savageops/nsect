import { describe, it, expect } from "vitest";
import {
  USER_AGENTS,
  VIEWPORTS,
  LOCALES,
  TIMEZONES,
  PLATFORMS,
  NOISE_SELECTORS,
  METHODS,
  FORMATS,
  pick,
  randomInt,
  generateFingerprint,
} from "../server/core/fingerprint.js";

describe("fingerprint constants", () => {
  it("USER_AGENTS is a non-empty array of strings", () => {
    expect(Array.isArray(USER_AGENTS)).toBe(true);
    expect(USER_AGENTS.length).toBeGreaterThan(0);
    for (const ua of USER_AGENTS) {
      expect(typeof ua).toBe("string");
      expect(ua.length).toBeGreaterThan(20);
    }
  });

  it("VIEWPORTS has width and height", () => {
    expect(VIEWPORTS.length).toBeGreaterThan(0);
    for (const vp of VIEWPORTS) {
      expect(vp).toHaveProperty("width");
      expect(vp).toHaveProperty("height");
      expect(vp.width).toBeGreaterThan(0);
      expect(vp.height).toBeGreaterThan(0);
    }
  });

  it("LOCALES contains valid locale strings", () => {
    expect(LOCALES.length).toBeGreaterThan(0);
    for (const loc of LOCALES) {
      expect(loc).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });

  it("TIMEZONES is non-empty", () => {
    expect(TIMEZONES.length).toBeGreaterThan(0);
  });

  it("NOISE_SELECTORS contains expected elements", () => {
    expect(NOISE_SELECTORS).toContain("script");
    expect(NOISE_SELECTORS).toContain("style");
    expect(NOISE_SELECTORS).toContain("nav");
    expect(NOISE_SELECTORS).toContain("footer");
  });

  it("METHODS has expected keys", () => {
    expect(Object.keys(METHODS)).toEqual(
      expect.arrayContaining(["direct", "wait", "scroll", "timed", "spa"]),
    );
  });

  it("FORMATS has expected values", () => {
    expect(FORMATS).toEqual(
      expect.arrayContaining(["text", "html", "markdown", "json", "links"]),
    );
  });
});

describe("pick()", () => {
  it("returns an element from the array", () => {
    const arr = ["a", "b", "c"];
    const result = pick(arr);
    expect(arr).toContain(result);
  });

  it("returns the only element for single-element array", () => {
    expect(pick(["only"])).toBe("only");
  });
});

describe("randomInt()", () => {
  it("returns values within range", () => {
    for (let i = 0; i < 100; i++) {
      const val = randomInt(5, 10);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(10);
    }
  });

  it("returns the same value when min equals max", () => {
    expect(randomInt(7, 7)).toBe(7);
  });
});

describe("generateFingerprint()", () => {
  it("returns a complete fingerprint object", () => {
    const fp = generateFingerprint();
    expect(fp).toHaveProperty("userAgent");
    expect(fp).toHaveProperty("viewport");
    expect(fp).toHaveProperty("locale");
    expect(fp).toHaveProperty("timezone");
    expect(fp).toHaveProperty("platform");
    expect(fp).toHaveProperty("webgl");
    expect(fp).toHaveProperty("colorDepth");
    expect(fp).toHaveProperty("deviceMemory");
    expect(fp).toHaveProperty("hardwareConcurrency");
    expect(fp).toHaveProperty("touchSupport");
    expect(fp).toHaveProperty("screen");
  });

  it("userAgent is from the known list", () => {
    const fp = generateFingerprint();
    expect(USER_AGENTS).toContain(fp.userAgent);
  });

  it("viewport is from the known list", () => {
    const fp = generateFingerprint();
    const vpStrings = VIEWPORTS.map((v) => `${v.width}x${v.height}`);
    expect(vpStrings).toContain(`${fp.viewport.width}x${fp.viewport.height}`);
  });

  it("locale is from the known list", () => {
    const fp = generateFingerprint();
    expect(LOCALES).toContain(fp.locale);
  });

  it("timezone is from the known list", () => {
    const fp = generateFingerprint();
    expect(TIMEZONES).toContain(fp.timezone);
  });

  it("platform matches user agent OS", () => {
    for (let i = 0; i < 20; i++) {
      const fp = generateFingerprint();
      if (fp.userAgent.includes("Windows")) expect(fp.platform).toBe("Win32");
      else if (fp.userAgent.includes("Mac")) expect(fp.platform).toBe("MacIntel");
      else if (fp.userAgent.includes("Linux")) expect(fp.platform).toBe("Linux x86_64");
    }
  });

  it("webgl has vendor and renderer", () => {
    const fp = generateFingerprint();
    expect(typeof fp.webgl.vendor).toBe("string");
    expect(typeof fp.webgl.renderer).toBe("string");
    expect(fp.webgl.vendor.length).toBeGreaterThan(0);
    expect(fp.webgl.renderer.length).toBeGreaterThan(0);
  });

  it("hardwareConcurrency is from valid set", () => {
    const valid = [2, 4, 6, 8, 12, 16];
    for (let i = 0; i < 20; i++) {
      const fp = generateFingerprint();
      expect(valid).toContain(fp.hardwareConcurrency);
    }
  });

  it("deviceMemory is from valid set", () => {
    const valid = [2, 4, 8, 16];
    for (let i = 0; i < 20; i++) {
      const fp = generateFingerprint();
      expect(valid).toContain(fp.deviceMemory);
    }
  });

  it("screen dimensions match viewport", () => {
    const fp = generateFingerprint();
    expect(fp.screen.width).toBe(fp.viewport.width);
    expect(fp.screen.height).toBe(fp.viewport.height);
    expect(fp.screen.availWidth).toBe(fp.viewport.width);
    expect(fp.screen.availHeight).toBeLessThanOrEqual(fp.viewport.height);
  });

  it("touchSupport has maxTouchPoints", () => {
    const fp = generateFingerprint();
    expect(typeof fp.touchSupport.maxTouchPoints).toBe("number");
  });

  it("generates unique fingerprints across calls", () => {
    const fps = new Set();
    for (let i = 0; i < 20; i++) {
      fps.add(JSON.stringify(generateFingerprint()));
    }
    expect(fps.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Locale ↔ timezone geographic coherence (anti-bot ML probes this)
// ---------------------------------------------------------------------------

describe("locale-timezone coherence", () => {
  // Run many iterations to catch statistical incoherence.
  it("en-AU locale never gets a non-AU timezone", () => {
    for (let i = 0; i < 100; i++) {
      const fp = generateFingerprint();
      if (fp.locale === "en-AU") {
        expect(fp.timezone).toBe("Australia/Sydney");
      }
    }
  });

  it("en-GB locale never gets a US timezone", () => {
    for (let i = 0; i < 100; i++) {
      const fp = generateFingerprint();
      if (fp.locale === "en-GB") {
        expect(fp.timezone).toBe("Europe/London");
        expect(fp.timezone).not.toContain("America");
      }
    }
  });

  it("en-NZ locale always gets Pacific/Auckland", () => {
    for (let i = 0; i < 100; i++) {
      const fp = generateFingerprint();
      if (fp.locale === "en-NZ") {
        expect(fp.timezone).toBe("Pacific/Auckland");
      }
    }
  });

  it("en-US locale gets a US timezone", () => {
    let foundUs = false;
    for (let i = 0; i < 200; i++) {
      const fp = generateFingerprint();
      if (fp.locale === "en-US") {
        foundUs = true;
        expect(fp.timezone.startsWith("America/")).toBe(true);
      }
    }
    // en-US should appear at least once in 200 iterations
    expect(foundUs).toBe(true);
  });
});

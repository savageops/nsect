import { describe, it, expect, afterEach } from "vitest";
import {
  resolveMode,
  buildRuntimeConfig,
  getRuntimeConfig,
  setRuntimeModeForTesting,
  resetRuntimeMode,
} from "../server/core/config.js";

afterEach(() => {
  resetRuntimeMode();
});

describe("resolveMode precedence", () => {
  it("defaults to local when no mode signal is set", () => {
    expect(resolveMode({})).toBe("local");
  });

  it("promotes to hosted when NSECT_HOSTED=1", () => {
    expect(resolveMode({ NSECT_HOSTED: "1" })).toBe("hosted");
  });

  it("accepts truthy variants of NSECT_HOSTED (true/yes)", () => {
    expect(resolveMode({ NSECT_HOSTED: "true" })).toBe("hosted");
    expect(resolveMode({ NSECT_HOSTED: "YES" })).toBe("hosted");
  });

  it("ignores empty/zero NSECT_HOSTED", () => {
    expect(resolveMode({ NSECT_HOSTED: "0" })).toBe("local");
    expect(resolveMode({ NSECT_HOSTED: "  " })).toBe("local");
  });

  it("promotes to hosted when NODE_ENV=production", () => {
    expect(resolveMode({ NODE_ENV: "production" })).toBe("hosted");
    expect(resolveMode({ NODE_ENV: "PRODUCTION" })).toBe("hosted");
  });

  it("NSECT_HOSTED wins over a non-production NODE_ENV", () => {
    expect(
      resolveMode({ NSECT_HOSTED: "1", NODE_ENV: "development" }),
    ).toBe("hosted");
  });
});

describe("buildRuntimeConfig", () => {
  it("local mode: adminKey is null, no ADMIN_KEY required", () => {
    const cfg = buildRuntimeConfig({});
    expect(cfg.mode).toBe("local");
    expect(cfg.hosted).toBe(false);
    expect(cfg.adminKey).toBeNull();
    expect(cfg.port).toBe(3000);
    expect(cfg.dbPath).toBeTruthy();
  });

  it("hosted mode requires a non-empty ADMIN_KEY (fail-fast)", () => {
    expect(() => buildRuntimeConfig({ NSECT_HOSTED: "1" })).toThrow(/ADMIN_KEY/);
    expect(() => buildRuntimeConfig({ NODE_ENV: "production" })).toThrow(/ADMIN_KEY/);
  });

  it("hosted mode: adminKey is the configured secret", () => {
    const cfg = buildRuntimeConfig({
      NSECT_HOSTED: "1",
      ADMIN_KEY: "a-strong-secret",
    });
    expect(cfg.hosted).toBe(true);
    expect(cfg.adminKey).toBe("a-strong-secret");
  });

  it("rejects out-of-range PORT", () => {
    expect(() => buildRuntimeConfig({ PORT: "0" })).toThrow(/PORT/);
    expect(() => buildRuntimeConfig({ PORT: "70000" })).toThrow(/PORT/);
    expect(() => buildRuntimeConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
  });

  it("honors NSECT_DB_PATH override", () => {
    const cfg = buildRuntimeConfig({ NSECT_DB_PATH: "/tmp/nsect-test.sqlite" });
    expect(cfg.dbPath).toBe("/tmp/nsect-test.sqlite");
  });

  it("returns a frozen object", () => {
    const cfg = buildRuntimeConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

describe("test seams", () => {
  it("setRuntimeModeForTesting forces the cached mode", () => {
    setRuntimeModeForTesting("local", { NSECT_HOSTED: "1" });
    expect(getRuntimeConfig().mode).toBe("local");

    setRuntimeModeForTesting("hosted", {
      NSECT_HOSTED: "1",
      ADMIN_KEY: "secret",
    });
    expect(getRuntimeConfig().mode).toBe("hosted");
    expect(getRuntimeConfig().adminKey).toBe("secret");
  });

  it("resetRuntimeMode clears the override", () => {
    setRuntimeModeForTesting("local");
    resetRuntimeMode();
    // Without a forced override and no env signal, defaults to local.
    expect(getRuntimeConfig().mode).toBe("local");
  });
});

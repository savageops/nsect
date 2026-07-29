import { describe, it, expect } from "vitest";
import { firstHeaderValue, readBearerToken } from "../server/core/http-headers.js";

describe("firstHeaderValue", () => {
  it("returns trimmed string value", () => {
    expect(firstHeaderValue("  sk_test  ")).toBe("sk_test");
  });

  it("returns null for empty string", () => {
    expect(firstHeaderValue("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(firstHeaderValue("   ")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(firstHeaderValue(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(firstHeaderValue(null)).toBeNull();
  });

  it("returns null for number", () => {
    expect(firstHeaderValue(123)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(firstHeaderValue([])).toBeNull();
  });

  it("returns first non-empty string from array", () => {
    expect(firstHeaderValue(["", "  ", "sk_real"])).toBe("sk_real");
  });

  it("skips non-string items in array", () => {
    expect(firstHeaderValue([123, null, "sk_valid"])).toBe("sk_valid");
  });

  it("trims array items", () => {
    expect(firstHeaderValue(["  sk_padded  "])).toBe("sk_padded");
  });

  it("returns null for array of empty strings", () => {
    expect(firstHeaderValue(["", "  ", ""])).toBeNull();
  });

  it("returns null for array of non-strings", () => {
    expect(firstHeaderValue([123, null, true])).toBeNull();
  });
});

describe("readBearerToken", () => {
  it("extracts token from 'Bearer <token>'", () => {
    expect(readBearerToken("Bearer sk_test_key")).toBe("sk_test_key");
  });

  it("extracts token from lowercase 'bearer <token>'", () => {
    expect(readBearerToken("bearer sk_test_key")).toBe("sk_test_key");
  });

  it("extracts token from mixed case 'BEARER <token>'", () => {
    expect(readBearerToken("BEARER sk_test_key")).toBe("sk_test_key");
  });

  it("trims the extracted token", () => {
    expect(readBearerToken("Bearer   sk_spaced   ")).toBe("sk_spaced");
  });

  it("returns null for empty string", () => {
    expect(readBearerToken("")).toBeNull();
  });

  it("returns null for non-Bearer auth scheme", () => {
    expect(readBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("returns null for 'Bearer' with no token", () => {
    expect(readBearerToken("Bearer")).toBeNull();
    expect(readBearerToken("Bearer ")).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(readBearerToken(undefined)).toBeNull();
  });

  it("extracts from array-form header (first Bearer value)", () => {
    expect(readBearerToken(["", "Bearer sk_from_array"])).toBe("sk_from_array");
  });

  it("handles tokens with special characters", () => {
    expect(readBearerToken("Bearer sk_abc-123_xyz.456")).toBe("sk_abc-123_xyz.456");
  });
});

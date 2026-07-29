import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Test the pure functions from harvest-search.mjs by importing them.
 * These functions are designed to be importable (the module guard prevents
 * auto-execution of main() when imported).
 */
import { slugify, collectQueries } from "../scripts/harvest-search.mjs";

describe("slugify", () => {
  it("lowercases and hyphenates a simple query", () => {
    expect(slugify("Open Source Crawlers", 0)).toMatch(/^001-/);
    expect(slugify("Open Source Crawlers", 0)).toContain("open-source-crawlers");
  });

  it("replaces non-alphanumeric chars with hyphens", () => {
    const result = slugify("Rust vs. Go: Which is Better?", 1);
    expect(result).toContain("rust-vs-go-which-is-better");
    expect(result.startsWith("002-")).toBe(true);
  });

  it("collapses consecutive non-alphanumeric into single hyphen", () => {
    const result = slugify("a   b!!!c", 0);
    expect(result).toContain("a-b-c");
  });

  it("falls back to 'query' for empty/all-special-char input", () => {
    const result = slugify("!!!@#$", 0);
    expect(result).toContain("query");
  });

  it("truncates slug to 72 chars (not counting index prefix and extension)", () => {
    const longQuery = "a".repeat(200);
    const result = slugify(longQuery, 0);
    // Strip the index prefix AND the .json extension to check the slug length
    const slug = result.replace(/^\d+-/, "").replace(/\.json$/, "");
    expect(slug.length).toBeLessThanOrEqual(72);
  });

  it("zero-pads the index to 3 digits", () => {
    expect(slugify("test", 0)).toMatch(/^001-/);
    expect(slugify("test", 9)).toMatch(/^010-/);
    expect(slugify("test", 99)).toMatch(/^100-/);
  });
});

describe("collectQueries", () => {
  it("collects from --query option", () => {
    const queries = collectQueries({ query: "rust async runtime" }, "/tmp");
    expect(queries).toEqual(["rust async runtime"]);
  });

  it("collects from multiple --query options", () => {
    const queries = collectQueries({ query: ["one", "two", "three"] }, "/tmp");
    expect(queries).toEqual(["one", "two", "three"]);
  });

  it("trims and filters empty queries", () => {
    const queries = collectQueries({ query: ["  valid  ", "", "   "] }, "/tmp");
    expect(queries).toEqual(["valid"]);
  });

  it("returns empty array when no query or query-file", () => {
    const queries = collectQueries({}, "/tmp");
    expect(queries).toEqual([]);
  });

  it("reads from --query-file, skipping comments and empty lines", () => {
    const tmpFile = resolve(tmpdir(), `queries-${randomUUID()}.txt`);
    writeFileSync(tmpFile, "first query\n# comment\n\nsecond query\n  # indented comment\nthird\n");

    try {
      const queries = collectQueries({ "query-file": tmpFile }, "/");
      expect(queries).toEqual(["first query", "second query", "third"]);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("throws friendly error for missing query-file", () => {
    expect(() => collectQueries({ "query-file": "/nonexistent/path.txt" }, "/")).toThrow(
      /query-file not found/,
    );
  });
});

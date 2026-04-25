import { describe, it, expect } from "vitest";
import { stripSpanSuffix } from "../src/cid-parser.js";

describe("stripSpanSuffix (V1 contract rules #19, #27)", () => {
  it("strips ' -  LD' suffix (note: two spaces before LD)", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B -  LD")).toBe("CITY-A - CITY-B");
  });
  it("strips ' - NSR' suffix (rule #27 — V1 elif was unreachable)", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B - NSR")).toBe("CITY-A - CITY-B");
  });
  it("trims trailing whitespace after stripping", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B -  LD   ")).toBe("CITY-A - CITY-B");
  });
  it("returns input unchanged when no suffix present", () => {
    expect(stripSpanSuffix("CITY-A - CITY-B")).toBe("CITY-A - CITY-B");
  });
  it("returns null for null input", () => {
    expect(stripSpanSuffix(null)).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(stripSpanSuffix("")).toBeNull();
  });
  it("strips both branches independently", () => {
    expect(stripSpanSuffix("X -  LD")).toBe("X");
    expect(stripSpanSuffix("X - NSR")).toBe("X");
  });
});

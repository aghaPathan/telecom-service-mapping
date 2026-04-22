import { describe, it, expect } from "vitest";
import { csvEscape, csvRow } from "@/lib/csv";

describe("csvEscape", () => {
  it("returns empty string for null", () => {
    expect(csvEscape(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(csvEscape(undefined)).toBe("");
  });

  it("returns plain string untouched when no special chars", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  it("quotes values that contain commas", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("doubles embedded double-quotes and wraps in quotes", () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("quotes values with newlines", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("prefixes leading = with apostrophe and quotes (formula injection)", () => {
    expect(csvEscape("=SUM(A1)")).toBe('"\'=SUM(A1)"');
  });

  it("prefixes leading + with apostrophe and quotes", () => {
    expect(csvEscape("+1")).toBe('"\'+1"');
  });

  it("prefixes leading - with apostrophe and quotes", () => {
    expect(csvEscape("-1")).toBe('"\'-1"');
  });

  it("prefixes leading @ with apostrophe and quotes", () => {
    expect(csvEscape("@foo")).toBe('"\'@foo"');
  });

  it("prefixes leading tab with apostrophe and quotes", () => {
    expect(csvEscape("\tfoo")).toBe('"\'\tfoo"');
  });

  it("stringifies numbers", () => {
    expect(csvEscape(42)).toBe("42");
  });
});

describe("csvRow", () => {
  it("joins cells with commas, escaping each and passing null through as empty", () => {
    expect(csvRow(["a", "b,c", null, 3])).toBe('a,"b,c",,3');
  });
});

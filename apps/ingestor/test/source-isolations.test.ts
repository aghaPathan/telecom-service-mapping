import { describe, it, expect } from "vitest";
import { parseConnectedNodes } from "../src/source/isolations";

describe("parseConnectedNodes", () => {
  it("splits V1 semicolon-delimited string into array", () => {
    expect(parseConnectedNodes("A;B;C")).toEqual(["A", "B", "C"]);
  });
  it("returns empty array for null", () => {
    expect(parseConnectedNodes(null)).toEqual([]);
  });
  it("returns empty array for empty string", () => {
    expect(parseConnectedNodes("")).toEqual([]);
  });
  it("trims whitespace and drops empty tokens", () => {
    expect(parseConnectedNodes(" A ; ; B ")).toEqual(["A", "B"]);
  });
});

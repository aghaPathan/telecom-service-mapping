import { describe, it, expect } from "vitest";
import { formatNullable } from "@/lib/format";

describe("formatNullable", () => {
  it("ruleFIX: null-as-null — null renders as —", () => {
    expect(formatNullable(null)).toBe("—");
  });
  it("ruleFIX: null-as-null — undefined renders as —", () => {
    expect(formatNullable(undefined)).toBe("—");
  });
  it("renders finite numbers as their string form", () => {
    expect(formatNullable(0)).toBe("0");
    expect(formatNullable(42)).toBe("42");
  });
  it("renders NaN/Infinity as dash", () => {
    expect(formatNullable(Number.NaN)).toBe("—");
    expect(formatNullable(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("renders non-empty strings unchanged", () => {
    expect(formatNullable("huawei")).toBe("huawei");
  });
  it("honors custom dash (e.g. empty string for CSV cells)", () => {
    expect(formatNullable(null, "")).toBe("");
  });
});

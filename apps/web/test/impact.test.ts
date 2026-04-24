import { describe, it, expect } from "vitest";
import { parseImpactQuery, HARD_CAP } from "@/lib/impact";

describe("parseImpactQuery", () => {
  it("requires non-empty device", () => {
    expect(() => parseImpactQuery({ device: "" })).toThrow();
  });

  it("coerces include_transport string to bool", () => {
    const q = parseImpactQuery({ device: "X", include_transport: "true" });
    expect(q.include_transport).toBe(true);
    const q2 = parseImpactQuery({ device: "X", include_transport: "false" });
    expect(q2.include_transport).toBe(false);
  });

  it("defaults include_transport to false and max_depth to 10", () => {
    const q = parseImpactQuery({ device: "X" });
    expect(q.include_transport).toBe(false);
    expect(q.max_depth).toBe(10);
  });

  it("caps max_depth at 15", () => {
    expect(() => parseImpactQuery({ device: "X", max_depth: 16 })).toThrow();
  });

  it("exposes HARD_CAP = 10000", () => {
    expect(HARD_CAP).toBe(10000);
  });
});

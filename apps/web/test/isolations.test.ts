import { describe, it, expect } from "vitest";
import { parseIsolationsQuery } from "@/lib/isolations";

describe("parseIsolationsQuery", () => {
  it("accepts optional vendor and device filters", () => {
    expect(parseIsolationsQuery({ vendor: "huawei", device: "UPE" })).toEqual({
      vendor: "huawei",
      device: "UPE",
      limit: 100,
    });
  });

  it("clamps limit to [1, 1000]", () => {
    expect(parseIsolationsQuery({ limit: "99999" }).limit).toBe(1000);
    expect(parseIsolationsQuery({ limit: "0" }).limit).toBe(1);
    expect(parseIsolationsQuery({ limit: "not-a-number" }).limit).toBe(100);
  });

  it("trims and drops empty strings", () => {
    const result = parseIsolationsQuery({ vendor: "  huawei  " });
    expect(result.vendor).toBe("huawei");
  });

  it("returns defaults when no input", () => {
    expect(parseIsolationsQuery({})).toEqual({ limit: 100 });
  });
});

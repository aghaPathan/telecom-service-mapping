import { describe, expect, it } from "vitest";
import { deriveSiteFromDeviceName } from "../src/site.ts";

describe("deriveSiteFromDeviceName", () => {
  it("extracts the two-token prefix from a canonical name", () => {
    expect(deriveSiteFromDeviceName("XX-YYY-CORE-01")).toBe("XX-YYY");
    expect(deriveSiteFromDeviceName("PK-KHI-CORE-01")).toBe("PK-KHI");
  });

  it("preserves case of the original tokens", () => {
    expect(deriveSiteFromDeviceName("xx-yyy-upe-03")).toBe("xx-yyy");
  });

  it("returns null when the name has fewer than three hyphen tokens", () => {
    expect(deriveSiteFromDeviceName("XX-YYY")).toBeNull();
    expect(deriveSiteFromDeviceName("SINGLETON")).toBeNull();
    expect(deriveSiteFromDeviceName("")).toBeNull();
  });

  it("returns null when a required token is empty", () => {
    expect(deriveSiteFromDeviceName("-YYY-CORE-01")).toBeNull();
    expect(deriveSiteFromDeviceName("XX--CORE-01")).toBeNull();
  });

  it("keeps only the first two tokens even when the name has many", () => {
    expect(deriveSiteFromDeviceName("XX-YYY-ZZZ-AAA-01")).toBe("XX-YYY");
  });
});

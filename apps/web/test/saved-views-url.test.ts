import { describe, it, expect } from "vitest";
import { savedViewToHref } from "@/lib/saved-views-url";

describe("savedViewToHref", () => {
  it("path/device → /path/:name", () => {
    expect(
      savedViewToHref({ kind: "path", query: { kind: "device", value: "E2E-SV-CSG" } }),
    ).toBe("/path/E2E-SV-CSG");
  });

  it("path/service → /service/:cid", () => {
    expect(
      savedViewToHref({ kind: "path", query: { kind: "service", value: "E2E-SV-CID" } }),
    ).toBe("/service/E2E-SV-CID");
  });

  it("path URL-encodes suspicious device names", () => {
    expect(
      savedViewToHref({ kind: "path", query: { kind: "device", value: "a/b c" } }),
    ).toBe("/path/a%2Fb%20c");
  });

  it("downstream → /device/:name/downstream with querystring", () => {
    expect(
      savedViewToHref({
        kind: "downstream",
        query: { device: "E2E-SV-UPE", include_transport: true, max_depth: 8 },
      }),
    ).toBe("/device/E2E-SV-UPE/downstream?include_transport=true&max_depth=8");
  });

  it("downstream encodes include_transport=false literally", () => {
    expect(
      savedViewToHref({
        kind: "downstream",
        query: { device: "X", include_transport: false, max_depth: 1 },
      }),
    ).toBe("/device/X/downstream?include_transport=false&max_depth=1");
  });
});

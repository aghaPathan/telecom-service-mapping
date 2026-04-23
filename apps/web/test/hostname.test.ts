import { describe, it, expect } from "vitest";
import { parseHostname } from "@tsm/db";

/**
 * Cross-workspace smoke test: proves `parseHostname` from `@tsm/db` is
 * importable + executable from the web workspace. Full-coverage tests live
 * alongside the ingestor unit suite (`apps/ingestor/test/hostname.test.ts`).
 */
describe("parseHostname (cross-workspace import)", () => {
  it("is importable from @tsm/db and parses a canonical hostname", () => {
    const result = parseHostname("JED-ICSG-NO01", {
      site_token_index: 0,
      role_token_index: 1,
      vendor_token_index: 2,
      separator: "-",
      role_map: { ICSG: "CSG" },
      vendor_token_map: { NO: "Nokia" },
    });
    expect(result).toEqual({
      site: "JED",
      role: "CSG",
      vendor: "Nokia",
      serial: "01",
    });
  });
});

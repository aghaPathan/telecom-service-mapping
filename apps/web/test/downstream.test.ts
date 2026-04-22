import { describe, it, expect } from "vitest";
import {
  parseDownstreamQuery,
  DownstreamResponse,
  MAX_DOWNSTREAM_DEPTH,
} from "@/lib/downstream";

describe("parseDownstreamQuery", () => {
  it("fills defaults when only device is provided", () => {
    const q = parseDownstreamQuery({ device: "d" });
    expect(q).toEqual({ device: "d", max_depth: 10, include_transport: false });
  });

  it("accepts include_transport as string 'true'", () => {
    const q = parseDownstreamQuery({ device: "d", include_transport: "true" });
    expect(q.include_transport).toBe(true);
  });

  it("accepts include_transport as string 'false'", () => {
    const q = parseDownstreamQuery({ device: "d", include_transport: "false" });
    expect(q.include_transport).toBe(false);
  });

  it("accepts include_transport as actual boolean true", () => {
    const q = parseDownstreamQuery({ device: "d", include_transport: true });
    expect(q.include_transport).toBe(true);
  });

  it("accepts include_transport as actual boolean false", () => {
    const q = parseDownstreamQuery({ device: "d", include_transport: false });
    expect(q.include_transport).toBe(false);
  });

  it("rejects missing device", () => {
    expect(() => parseDownstreamQuery({})).toThrow();
  });

  it("rejects empty device string", () => {
    expect(() => parseDownstreamQuery({ device: "" })).toThrow();
    expect(() => parseDownstreamQuery({ device: "   " })).toThrow();
  });

  it("rejects device longer than 200 chars", () => {
    expect(() => parseDownstreamQuery({ device: "x".repeat(201) })).toThrow();
  });

  it("rejects max_depth=0", () => {
    expect(() => parseDownstreamQuery({ device: "d", max_depth: 0 })).toThrow();
  });

  it(`rejects max_depth=${MAX_DOWNSTREAM_DEPTH + 1}`, () => {
    expect(() =>
      parseDownstreamQuery({ device: "d", max_depth: MAX_DOWNSTREAM_DEPTH + 1 }),
    ).toThrow();
  });

  it("rejects max_depth='abc' (non-numeric string)", () => {
    expect(() =>
      parseDownstreamQuery({ device: "d", max_depth: "abc" }),
    ).toThrow();
  });

  it("accepts max_depth='5' (coerced from string)", () => {
    const q = parseDownstreamQuery({ device: "d", max_depth: "5" });
    expect(q.max_depth).toBe(5);
  });
});

describe("DownstreamResponse schema", () => {
  it("accepts ok shape", () => {
    const r = DownstreamResponse.parse({
      status: "ok",
      start: {
        name: "A",
        role: "UPE",
        level: 2,
        site: "S",
        domain: "D",
      },
      total: 3,
      groups: [
        {
          level: 3,
          role: "CSG",
          count: 1,
          devices: [
            {
              name: "B",
              role: "CSG",
              level: 3,
              site: null,
              domain: null,
            },
          ],
        },
      ],
    });
    expect(r.status).toBe("ok");
  });

  it("accepts start_not_found shape", () => {
    const r = DownstreamResponse.parse({ status: "start_not_found" });
    expect(r.status).toBe("start_not_found");
  });

  it("rejects unknown status", () => {
    expect(() =>
      DownstreamResponse.parse({ status: "maybe" }),
    ).toThrow();
  });
});

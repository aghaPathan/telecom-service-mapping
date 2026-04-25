import { describe, it, expect } from "vitest";
import { parsePathQuery, PathResponse } from "@/lib/path";

describe("parsePathQuery", () => {
  it("parses device: prefix", () => {
    const q = parsePathQuery({ from: "device:PK-KHI-UPE-01" });
    expect(q).toEqual({ kind: "device", value: "PK-KHI-UPE-01" });
  });

  it("parses service: prefix", () => {
    const q = parsePathQuery({ from: "service:C-001" });
    expect(q).toEqual({ kind: "service", value: "C-001" });
  });

  it("rejects missing prefix", () => {
    expect(() => parsePathQuery({ from: "PK-KHI-UPE-01" })).toThrow();
  });

  it("rejects unknown prefix", () => {
    expect(() => parsePathQuery({ from: "site:KHI" })).toThrow();
  });

  it("rejects empty value", () => {
    expect(() => parsePathQuery({ from: "device:" })).toThrow();
    expect(() => parsePathQuery({ from: "device:   " })).toThrow();
  });

  it("caps value length at 200 after prefix", () => {
    const ok = `device:${"x".repeat(200)}`;
    expect(parsePathQuery({ from: ok }).value.length).toBe(200);
    const bad = `device:${"x".repeat(201)}`;
    expect(() => parsePathQuery({ from: bad })).toThrow();
  });

  it("trims inner whitespace on value", () => {
    const q = parsePathQuery({ from: "device:  d1  " });
    expect(q.value).toBe("d1");
  });

  it("rejects missing from", () => {
    expect(() => parsePathQuery({})).toThrow();
  });
});

describe("PathResponse schema", () => {
  it("accepts ok shape with hops", () => {
    const r = PathResponse.parse({
      status: "ok",
      length: 2,
      weighted: false,
      total_weight: null,
      hops: [
        {
          name: "a",
          role: "Customer",
          level: 5,
          site: "S",
          domain: "D",
          in_if: null,
          out_if: "out-1",
          edge_weight_in: null,
        },
        {
          name: "b",
          role: "CSG",
          level: 3,
          site: null,
          domain: null,
          in_if: "in-1",
          out_if: "out-2",
          edge_weight_in: null,
        },
        {
          name: "c",
          role: "CORE",
          level: 1,
          site: "S",
          domain: "D",
          in_if: "in-2",
          out_if: null,
          edge_weight_in: null,
        },
      ],
    });
    expect(r.status).toBe("ok");
  });

  it("accepts no_path shape with reason and unreached_at", () => {
    const r = PathResponse.parse({
      status: "no_path",
      reason: "island",
      unreached_at: { name: "Island", role: "CSG", level: 3, site: null, domain: null },
    });
    expect(r.status).toBe("no_path");
  });

  it("accepts no_path with unreached_at null", () => {
    const r = PathResponse.parse({
      status: "no_path",
      reason: "start_not_found",
      unreached_at: null,
    });
    expect(r.status).toBe("no_path");
  });

  it("rejects unknown reason string", () => {
    expect(() =>
      PathResponse.parse({
        status: "no_path",
        reason: "banana",
        unreached_at: null,
      }),
    ).toThrow();
  });

  it("rejects unknown status", () => {
    expect(() =>
      PathResponse.parse({
        status: "maybe",
        length: 0,
        hops: [],
      }),
    ).toThrow();
  });
});

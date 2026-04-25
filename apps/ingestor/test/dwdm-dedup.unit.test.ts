import { describe, it, expect } from "vitest";
import { dedupDwdmRows } from "../src/dedup.js";
import type { RawDwdmRow } from "../src/source/dwdm.js";

function row(overrides: Partial<RawDwdmRow> = {}): RawDwdmRow {
  return {
    device_a_name: "XX-AAA",
    device_a_interface: "Eth0/0",
    device_a_ip: null,
    device_b_name: "XX-BBB",
    device_b_interface: "Eth0/1",
    device_b_ip: null,
    ring: "RING-1",
    snfn_cids: null,
    mobily_cids: null,
    span_name: null,
    ...overrides,
  };
}

describe("dedupDwdmRows", () => {
  it("collapses symmetric pair (A->B, B->A) to one canonical edge", () => {
    const r1 = row({ device_a_name: "XX-AAA", device_b_name: "XX-BBB" });
    const r2 = row({
      device_a_name: "XX-BBB",
      device_a_interface: "Eth0/1",
      device_b_name: "XX-AAA",
      device_b_interface: "Eth0/0",
    });
    const result = dedupDwdmRows([r1, r2]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.src).toBe("XX-AAA");
    expect(result.edges[0]!.dst).toBe("XX-BBB");
    expect(result.dropped).toEqual({ null_b: 0, self_loop: 0, anomaly: 0 });
  });

  it("drops self-loop (case-insensitive)", () => {
    const result = dedupDwdmRows([
      row({ device_a_name: "XX-AAA", device_b_name: "xx-aaa" }),
    ]);
    expect(result.edges).toHaveLength(0);
    expect(result.dropped.self_loop).toBe(1);
  });

  it("drops null device_b_name", () => {
    const result = dedupDwdmRows([
      row({ device_a_name: "XX-AAA", device_b_name: null }),
    ]);
    expect(result.edges).toHaveLength(0);
    expect(result.dropped.null_b).toBe(1);
  });

  it("drops null device_a_name", () => {
    const result = dedupDwdmRows([
      row({ device_a_name: null, device_b_name: "XX-BBB" }),
    ]);
    expect(result.edges).toHaveLength(0);
    expect(result.dropped.null_b).toBe(1);
  });

  it("3 rows with same canonical key → 1 edge, 1 anomaly", () => {
    const r1 = row({ device_a_name: "XX-AAA", device_b_name: "XX-BBB" });
    const r2 = row({ device_a_name: "XX-BBB", device_b_name: "XX-AAA" });
    const r3 = row({ device_a_name: "XX-AAA", device_b_name: "XX-BBB" });
    const result = dedupDwdmRows([r1, r2, r3]);
    expect(result.edges).toHaveLength(1);
    expect(result.dropped.anomaly).toBe(1);
  });

  it("strips ' -  LD' from span_name on output edge", () => {
    const result = dedupDwdmRows([
      row({ span_name: "CITY-A - CITY-B -  LD" }),
    ]);
    expect(result.edges[0]!.span_name).toBe("CITY-A - CITY-B");
  });

  it("parses snfn_cids 'S1 S2' → ['S1', 'S2']", () => {
    const result = dedupDwdmRows([row({ snfn_cids: "S1 S2" })]);
    expect(result.edges[0]!.snfn_cids).toEqual(["S1", "S2"]);
  });

  it("parses mobily_cids 'M1,M2' → ['M1', 'M2']", () => {
    const result = dedupDwdmRows([row({ mobily_cids: "M1,M2" })]);
    expect(result.edges[0]!.mobily_cids).toEqual(["M1", "M2"]);
  });

  it("'nan' snfn_cids → []", () => {
    const result = dedupDwdmRows([row({ snfn_cids: "nan" })]);
    expect(result.edges[0]!.snfn_cids).toEqual([]);
  });

  it("NULL span_name → null", () => {
    const result = dedupDwdmRows([row({ span_name: null })]);
    expect(result.edges[0]!.span_name).toBeNull();
  });

  it("canonical direction: input ('XX-BBB','XX-AAA') yields src='XX-AAA',dst='XX-BBB' with mirrored interfaces", () => {
    const result = dedupDwdmRows([
      row({
        device_a_name: "XX-BBB",
        device_a_interface: "IfB",
        device_b_name: "XX-AAA",
        device_b_interface: "IfA",
      }),
    ]);
    expect(result.edges).toHaveLength(1);
    const e = result.edges[0]!;
    expect(e.src).toBe("XX-AAA");
    expect(e.dst).toBe("XX-BBB");
    expect(e.src_interface).toBe("IfA");
    expect(e.dst_interface).toBe("IfB");
  });

  it("empty input → empty edges, zero counters", () => {
    expect(dedupDwdmRows([])).toEqual({
      edges: [],
      dropped: { null_b: 0, self_loop: 0, anomaly: 0 },
    });
  });
});

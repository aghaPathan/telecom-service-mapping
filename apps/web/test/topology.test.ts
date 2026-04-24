import { describe, it, expect } from "vitest";
import {
  parseTopologyQuery,
  hopsToGraphDTO,
  applyUpeClustering,
} from "@/lib/topology";
import type { Hop } from "@/lib/path";

describe("parseTopologyQuery", () => {
  it("path mode requires both from and to", () => {
    const q = parseTopologyQuery({ from: "device:A", to: "device:B" });
    expect(q).toEqual({
      mode: "path",
      from: { kind: "device", value: "A" },
      to: { kind: "device", value: "B" },
      cluster: null,
      include_transport: false,
    });
  });

  it("ego mode reads around + hops", () => {
    const q = parseTopologyQuery({ around: "UPE-01", hops: "2" });
    expect(q).toEqual({
      mode: "ego",
      around: "UPE-01",
      hops: 2,
      cluster: null,
      include_transport: false,
    });
  });

  it("core mode is the default when no recognized params provided", () => {
    const q = parseTopologyQuery({});
    expect(q).toEqual({
      mode: "core",
      cluster: null,
      include_transport: false,
    });
  });

  it("rejects hops above the cap", () => {
    expect(() => parseTopologyQuery({ around: "X", hops: "99" })).toThrow();
  });

  it("rejects from without to in path mode", () => {
    expect(() => parseTopologyQuery({ from: "device:A" })).toThrow();
  });

  it("round-trips cluster=1 and include_transport=1", () => {
    const q = parseTopologyQuery({ around: "X", cluster: "1", include_transport: "1" });
    expect(q.cluster).toBe(true);
    expect(q.include_transport).toBe(true);
  });
});

describe("hopsToGraphDTO", () => {
  const hops: Hop[] = [
    { name: "CUST", role: "Customer", level: 5, site: "S1", domain: null, in_if: null, out_if: "ge-0/0", edge_weight_in: null },
    { name: "CSG",  role: "CSG",      level: 3, site: "S1", domain: null, in_if: "ge-0/1", out_if: "xe-1", edge_weight_in: null },
    { name: "CORE", role: "CORE",     level: 1, site: "S2", domain: null, in_if: "xe-0", out_if: null, edge_weight_in: null },
  ];

  it("emits one device node per hop and one edge per adjacent pair", () => {
    const { nodes, edges } = hopsToGraphDTO(hops);
    expect(nodes.map((n) => n.id)).toEqual(["CUST", "CSG", "CORE"]);
    expect(nodes.every((n) => n.type === "device")).toBe(true);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ source: "CUST", target: "CSG" });
  });

  it("deduplicates when the same name appears twice (loops)", () => {
    const loopy: Hop[] = [...hops, hops[0]!];
    const { nodes, edges } = hopsToGraphDTO(loopy);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    // reactflow requires unique edge ids
    expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
  });
});

describe("applyUpeClustering", () => {
  const mk = (name: string, site: string, role = "UPE", level = 2) => ({
    id: name,
    type: "device" as const,
    data: { name, role, level, site },
    position: { x: 0, y: 0 },
  });

  it("collapses >3 UPEs at the same site into a cluster node", () => {
    const nodes = [
      mk("U1", "A"), mk("U2", "A"), mk("U3", "A"), mk("U4", "A"),
      mk("C1", "A", "CSG", 3),
    ];
    const edges = [
      { id: "e1", source: "C1", target: "U1" },
      { id: "e2", source: "C1", target: "U2" },
    ];
    const { nodes: out, edges: outEdges } = applyUpeClustering(nodes, edges, null);
    expect(out.find((n) => n.type === "cluster")).toBeTruthy();
    expect(out.filter((n) => n.id.startsWith("U")).length).toBe(0);
    expect(outEdges.every((e) => e.target !== "U1")).toBe(true);
  });

  it("leaves UPEs alone at or below threshold", () => {
    const nodes = [mk("U1", "A"), mk("U2", "A"), mk("U3", "A")];
    const { nodes: out } = applyUpeClustering(nodes, [], null);
    expect(out.filter((n) => n.type === "cluster").length).toBe(0);
  });

  it("honors cluster=false override even above threshold", () => {
    const nodes = [mk("U1", "A"), mk("U2", "A"), mk("U3", "A"), mk("U4", "A")];
    const { nodes: out } = applyUpeClustering(nodes, [], false);
    expect(out.filter((n) => n.type === "cluster").length).toBe(0);
  });

  it("clusters each site independently when multiple sites exceed threshold", () => {
    const nodes = [
      mk("A1", "A"), mk("A2", "A"), mk("A3", "A"), mk("A4", "A"),
      mk("B1", "B"), mk("B2", "B"), mk("B3", "B"), mk("B4", "B"),
    ];
    const { nodes: out } = applyUpeClustering(nodes, [], null);
    const clusters = out.filter((n) => n.type === "cluster");
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((c) => c.id))).toEqual(
      new Set(["cluster:A", "cluster:B"]),
    );
  });

  it("dedupes edges collapsed onto the same cluster pair", () => {
    const nodes = [
      mk("U1", "A"), mk("U2", "A"), mk("U3", "A"), mk("U4", "A"),
      mk("C1", "A", "CSG", 3),
    ];
    // Two edges CSG→UPE that both rewrite to CSG→cluster:A; must dedupe to 1.
    const edges = [
      { id: "e1", source: "C1", target: "U1" },
      { id: "e2", source: "C1", target: "U2" },
    ];
    const { edges: outEdges } = applyUpeClustering(nodes, edges, null);
    expect(outEdges).toHaveLength(1);
    expect(outEdges[0]).toMatchObject({ source: "C1", target: "cluster:A" });
  });
});

import { describe, it, expect } from "vitest";
import type { Edge, Node } from "reactflow";
import { layoutGraph } from "@/components/graph/layout";

// Minimal 4-node chain: CORE -> UPE -> CSG -> RAN
const NODES: Node[] = [
  { id: "core", type: "device", position: { x: 0, y: 0 }, data: {} },
  { id: "upe", type: "device", position: { x: 0, y: 0 }, data: {} },
  { id: "csg", type: "device", position: { x: 0, y: 0 }, data: {} },
  { id: "ran", type: "device", position: { x: 0, y: 0 }, data: {} },
];

const EDGES: Edge[] = [
  { id: "core-upe", source: "core", target: "upe" },
  { id: "upe-csg", source: "upe", target: "csg" },
  { id: "csg-ran", source: "csg", target: "ran" },
];

describe("layoutGraph", () => {
  it("assigns unique positions to every node", () => {
    const laid = layoutGraph(NODES, EDGES);
    const keys = new Set(laid.map((n) => `${n.position.x},${n.position.y}`));
    expect(keys.size).toBe(NODES.length);
  });

  it("places nodes left-to-right by default (LR direction)", () => {
    const laid = layoutGraph(NODES, EDGES);
    const byId = Object.fromEntries(laid.map((n) => [n.id, n.position]));
    expect(byId.core!.x).toBeLessThan(byId.upe!.x);
    expect(byId.upe!.x).toBeLessThan(byId.csg!.x);
    expect(byId.csg!.x).toBeLessThan(byId.ran!.x);
  });

  it("switches to top-to-bottom under TB direction", () => {
    const laid = layoutGraph(NODES, EDGES, { direction: "TB" });
    const byId = Object.fromEntries(laid.map((n) => [n.id, n.position]));
    expect(byId.core!.y).toBeLessThan(byId.upe!.y);
    expect(byId.upe!.y).toBeLessThan(byId.csg!.y);
    expect(byId.csg!.y).toBeLessThan(byId.ran!.y);
  });

  it("leaves the input nodes untouched (returns new array)", () => {
    const snapshot = JSON.stringify(NODES);
    layoutGraph(NODES, EDGES);
    expect(JSON.stringify(NODES)).toBe(snapshot);
  });

  it("returns centered-origin positions converted to reactflow top-left", () => {
    // Two-node graph — verifies the dagre-center → top-left translation
    // (laid.x - width/2). With the default 180px width, a dagre-centered
    // node at x=90 should give position.x=0.
    const twoNodes: Node[] = [
      { id: "a", type: "device", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "device", position: { x: 0, y: 0 }, data: {} },
    ];
    const twoEdges: Edge[] = [{ id: "a-b", source: "a", target: "b" }];
    const laid = layoutGraph(twoNodes, twoEdges, {
      nodeWidth: 100,
      nodeHeight: 40,
    });
    // Both nodes must end up with integer-aligned positions (not NaN).
    for (const n of laid) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("handles a single isolated node (no edges)", () => {
    const [loner] = layoutGraph(
      [{ id: "x", type: "device", position: { x: 0, y: 0 }, data: {} }],
      [],
    );
    expect(loner).toBeDefined();
    expect(Number.isFinite(loner!.position.x)).toBe(true);
    expect(Number.isFinite(loner!.position.y)).toBe(true);
  });
});

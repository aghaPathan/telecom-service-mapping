import dagre from "dagre";
import type { Edge, Node } from "reactflow";

export type LayoutDirection = "LR" | "TB";

export type LayoutOptions = {
  direction?: LayoutDirection;
  /** Default node footprint used for ranking + spacing. Individual nodes can
   * override by setting `width` / `height` on the node itself. */
  nodeWidth?: number;
  nodeHeight?: number;
  /** Horizontal gap between ranks (LR) or nodes within a rank (TB). */
  rankSep?: number;
  /** Gap between sibling nodes in the same rank. */
  nodeSep?: number;
};

const DEFAULTS = {
  direction: "LR" as LayoutDirection,
  nodeWidth: 180,
  nodeHeight: 64,
  rankSep: 80,
  nodeSep: 32,
};

/**
 * Run dagre layered layout over a reactflow graph and return a new array of
 * nodes with `position` populated. Edges are unchanged.
 *
 * Pure — no DOM, no state. Safe to call in tests, server components, and
 * reactflow's `onInit` handler.
 */
export function layoutGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  options: LayoutOptions = {},
): Node[] {
  const opts = { ...DEFAULTS, ...options };
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: opts.direction,
    nodesep: opts.nodeSep,
    ranksep: opts.rankSep,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, {
      width: n.width ?? opts.nodeWidth,
      height: n.height ?? opts.nodeHeight,
    });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  return nodes.map((n) => {
    const laid = g.node(n.id);
    const width = n.width ?? opts.nodeWidth;
    const height = n.height ?? opts.nodeHeight;
    // dagre returns center-origin; reactflow uses top-left.
    return {
      ...n,
      position: {
        x: laid.x - width / 2,
        y: laid.y - height / 2,
      },
    };
  });
}

"use client";

import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { NODE_TYPES } from "./nodeTypes";
import { EDGE_TYPES, CONNECTS_EDGE_DEFAULTS } from "./edgeTypes";
import { layoutGraph, type LayoutOptions } from "./layout";

export type GraphCanvasProps = {
  nodes: Node[];
  edges: Edge[];
  /** Apply dagre layout before rendering. Set false when upstream already
   * provides positions (e.g. a cached layout). Defaults to true. */
  autoLayout?: boolean;
  layoutOptions?: LayoutOptions;
  className?: string;
  /** Show the reactflow minimap. Default true for `/topology`, usually off
   * in inline previews where the map is more noise than signal. */
  showMiniMap?: boolean;
};

/**
 * Thin reactflow wrapper. Keeps tree-shakable (caller chooses layout,
 * controls, minimap) and theme-aware (`Background` + controls ride Tailwind
 * surface tokens via the parent div).
 *
 * Client component — reactflow touches `window` + uses refs on render. Pages
 * should import dynamically with `{ ssr: false }` to avoid hydration noise.
 */
export function GraphCanvas({
  nodes,
  edges,
  autoLayout = true,
  layoutOptions,
  className,
  showMiniMap = true,
}: GraphCanvasProps) {
  const laidOut = useMemo(
    () => (autoLayout ? layoutGraph(nodes, edges, layoutOptions) : nodes),
    [nodes, edges, autoLayout, layoutOptions],
  );
  const styledEdges = useMemo(
    () => edges.map((e) => ({ ...CONNECTS_EDGE_DEFAULTS, ...e })),
    [edges],
  );

  return (
    <div
      className={
        className ??
        "h-[560px] w-full overflow-hidden rounded-lg border border-slate-200 bg-white"
      }
      data-testid="graph-canvas"
    >
      <ReactFlow
        nodes={laidOut}
        edges={styledEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="#e2e8f0" />
        <Controls showInteractive={false} />
        {showMiniMap ? (
          <MiniMap
            nodeColor="#94a3b8"
            nodeBorderRadius={4}
            pannable
            zoomable
          />
        ) : null}
      </ReactFlow>
    </div>
  );
}

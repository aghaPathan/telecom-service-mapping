"use client";

import type { Edge, Node } from "reactflow";
import { GraphCanvas } from "@/components/graph/GraphCanvas";

// Exists ONLY so the server page can dynamic-import it with ssr:false —
// reactflow touches `window` at import time. Mirrors graph-preview/preview-canvas.
export function TopologyCanvas({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}) {
  return <GraphCanvas nodes={nodes} edges={edges} />;
}

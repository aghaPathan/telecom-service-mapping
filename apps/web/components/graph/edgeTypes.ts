import { MarkerType, type EdgeTypes } from "reactflow";

// Keep the default edge renderer — reactflow's built-in `default` handles
// styling via `style` + `markerEnd` props without a custom component.
// Exported as `EDGE_TYPES` so future custom edges (e.g. a branded trunk
// edge for LAGs) plug in without changing callers.
export const EDGE_TYPES: EdgeTypes = {};

// Shared styling for `:CONNECTS_TO` edges — plumbed via each edge's
// `style` / `markerEnd` props rather than a custom component because the
// default edge already handles everything we need today (S17 can revisit).
export const CONNECTS_EDGE_DEFAULTS = {
  type: "default",
  animated: false,
  style: { stroke: "#64748b", strokeWidth: 1.5 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: "#64748b",
    width: 14,
    height: 14,
  },
} as const;

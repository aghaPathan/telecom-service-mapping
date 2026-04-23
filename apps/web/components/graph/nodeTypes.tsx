"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { iconFor } from "@/lib/icons";
import { ClusterNode, type ClusterNodeData } from "./ClusterNode";

export type DeviceNodeData = {
  name: string;
  role: string;
  level?: number | null;
  site?: string | null;
};

export type { ClusterNodeData };

// Level-indexed ring color for the left border. Kept independent of the role
// icon palette in lib/icons so the canvas stays legible against any theme.
function levelRingClass(level: number | null | undefined): string {
  switch (level) {
    case 1:
      return "border-l-violet-500";
    case 2:
      return "border-l-indigo-500";
    case 3:
    case 3.5:
      return "border-l-blue-500";
    case 4:
      return "border-l-teal-500";
    case 5:
      return "border-l-emerald-500";
    default:
      return "border-l-slate-400";
  }
}

function DeviceNodeImpl({ data }: NodeProps<DeviceNodeData>) {
  return (
    <div
      className={`flex min-w-[160px] items-center gap-2 rounded-md border border-slate-200 border-l-4 bg-white px-3 py-2 shadow-sm ${levelRingClass(
        data.level,
      )}`}
      data-testid="graph-device-node"
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <span className="shrink-0">{iconFor(data.role)}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-slate-800">
          {data.name}
        </span>
        <span className="truncate text-xs text-slate-500">
          {data.role}
          {data.site ? ` · ${data.site}` : ""}
        </span>
      </span>
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
    </div>
  );
}

export const DeviceNode = memo(DeviceNodeImpl);
export { ClusterNode };

// reactflow keys node renderers by string id — bundled into one object so
// callers can pass `nodeTypes={NODE_TYPES}` without reshaping on every render.
export const NODE_TYPES = {
  device: DeviceNode,
  cluster: ClusterNode,
} as const;

export type GraphNodeType = keyof typeof NODE_TYPES;

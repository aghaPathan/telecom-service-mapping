"use client";

import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { iconFor } from "@/lib/icons";

export type ClusterDeviceRef = { name: string; role: string };

export type ClusterNodeData = {
  site: string;
  role: string;
  count: number;
  /** Individual devices behind the cluster; rendered when expanded. */
  devices?: ClusterDeviceRef[];
  /** Initial expand state. Used by tests and by callers that want the
   *  cluster to open automatically on a deep-link. Defaults to false. */
  defaultExpanded?: boolean;
};

/**
 * Pure presentation — separated from the reactflow wrapper so tests can
 * render it with `renderToStaticMarkup` without spinning up a ReactFlow
 * zustand provider (the Handle component requires one). Also reusable
 * in non-reactflow contexts (e.g. inline previews).
 */
export function ClusterNodeContent({ data }: { data: ClusterNodeData }) {
  const [expanded, setExpanded] = useState(data.defaultExpanded ?? false);
  const devices = data.devices ?? [];

  return (
    <div
      className="flex min-w-[180px] flex-col gap-1 rounded-md border border-dashed border-slate-400 bg-slate-50 px-3 py-2 shadow-sm dark:border-slate-600 dark:bg-slate-800"
      data-testid="graph-cluster-node"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0">{iconFor(data.role)}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {data.site} · {data.role}
          </span>
          <span className="truncate text-xs text-slate-500 dark:text-slate-400">
            {data.count} devices
          </span>
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse cluster" : "Expand cluster"}
          data-testid="cluster-toggle"
          className="ml-auto rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
        >
          {expanded ? "−" : "+"}
        </button>
      </div>
      {expanded && devices.length > 0 ? (
        <ul
          className="mt-1 max-h-40 overflow-auto border-t border-slate-200 pt-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
          data-testid="cluster-device-list"
        >
          {devices.map((d) => (
            <li key={d.name} className="truncate">
              {d.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Reactflow custom node that represents a collapsed group of devices
 * (typically >3 UPEs at the same site — see `lib/cluster.ts`).
 * The cluster's topology edges stay on the cluster node itself — expanding
 * the internal list does NOT re-render individual reactflow nodes, which
 * keeps layout stable.
 */
function ClusterNodeImpl({ data }: NodeProps<ClusterNodeData>) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <ClusterNodeContent data={data} />
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
    </div>
  );
}

export const ClusterNode = memo(ClusterNodeImpl);

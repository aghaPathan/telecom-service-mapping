"use client";

// reactflow / TopologyCanvas touches `window` at import time.
// This component is loaded only via next/dynamic({ssr:false}) from the
// server page — never import it directly in a server component.
import type { Node, Edge } from "reactflow";
import { TopologyCanvas } from "@/app/topology/topology-canvas";
import type { GraphNodeDTO, GraphEdgeDTO } from "@/lib/topology";

type Props = {
  site: string;
  data: { nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] };
};

export function SiteTopologyPanel({ site, data }: Props) {
  return (
    <section aria-label={`Topology around ${site}`} className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-slate-700">
        Topology — <span className="font-semibold">{site}</span>
      </h2>
      {data.nodes.length === 0 ? (
        <div
          data-testid="site-topology-empty"
          className="flex h-[420px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500"
        >
          No devices found for site {site}.
        </div>
      ) : (
        <div style={{ height: 420 }} className="rounded-lg border border-slate-200 overflow-hidden">
          <TopologyCanvas
            nodes={data.nodes as unknown as Node[]}
            edges={data.edges as unknown as Edge[]}
          />
        </div>
      )}
    </section>
  );
}

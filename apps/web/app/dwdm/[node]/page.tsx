import nextDynamic from "next/dynamic";
import type { Edge, Node } from "reactflow";
import { requireRole } from "@/lib/rbac";
import { getNodeDwdm, type EdgeDto, type NodeDto } from "@/lib/dwdm";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

function CanvasSkeleton() {
  return (
    <div className="flex h-[560px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500">
      Loading graph…
    </div>
  );
}

// reactflow needs `window` at import time. Mount the canvas client-only so
// the surrounding page stays server-rendered. Mirrors /topology.
const DwdmCanvas = nextDynamic(
  () => import("./dwdm-canvas").then((m) => m.DwdmCanvas),
  { ssr: false, loading: () => <CanvasSkeleton /> },
);

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-100"
      data-testid="dwdm-node-error"
    >
      {message}
    </div>
  );
}

function toGraph(
  nodes: NodeDto[],
  edges: EdgeDto[],
): { rfNodes: Node[]; rfEdges: Edge[] } {
  // The registered `device` node renderer in components/graph/nodeTypes.tsx
  // reads `data.{name,role,level,site}` directly — keep the shape flat.
  const rfNodes: Node[] = nodes.map((n) => ({
    id: n.name,
    type: "device",
    data: {
      name: n.name,
      role: n.role ?? "Unknown",
      level: n.level,
      site: n.site,
      // domain is carried for future use; the device renderer ignores it.
      domain: n.domain,
    },
    position: { x: 0, y: 0 },
  }));

  const seen = new Set<string>();
  const rfEdges: Edge[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue;
    const id = `${e.a}--${e.b}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rfEdges.push({
      id,
      source: e.a,
      target: e.b,
      type: "default",
      data: {
        ring: e.ring,
        span_name: e.span_name,
        snfn_cids: e.snfn_cids,
        mobily_cids: e.mobily_cids,
        src_interface: e.src_interface,
        dst_interface: e.dst_interface,
      },
      label: e.ring ?? "",
    });
  }
  return { rfNodes, rfEdges };
}

export default async function DwdmNodePage({
  params,
}: {
  params: { node: string };
}) {
  await requireRole("viewer");

  const nodeName = decodeURIComponent(params.node);

  let result: { nodes: NodeDto[]; edges: EdgeDto[] };
  try {
    result = await getNodeDwdm(nodeName);
  } catch (err) {
    log("error", "dwdm_node_page_failed", {
      node: nodeName,
      error: err instanceof Error ? err.message : String(err),
    });
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="dwdm-node-heading"
        >
          DWDM topology — {nodeName}
        </h1>
        <div className="mt-6">
          <ErrorPanel message="DWDM topology unavailable. Neo4j may be offline — try again in a moment." />
        </div>
      </main>
    );
  }

  if (result.nodes.length === 0) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="dwdm-node-heading"
        >
          DWDM topology — {nodeName}
        </h1>
        <div className="mt-6">
          <p
            className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-600"
            data-testid="dwdm-node-empty"
          >
            No DWDM links found for this device.
          </p>
          <a
            href="/dwdm"
            className="mt-3 inline-block text-xs text-sky-700 hover:underline"
            data-testid="dwdm-node-back"
          >
            ← Back to DWDM links
          </a>
        </div>
      </main>
    );
  }

  const { rfNodes, rfEdges } = toGraph(result.nodes, result.edges);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-start justify-between gap-4">
        <h1
          className="text-2xl font-semibold tracking-tight text-slate-900"
          data-testid="dwdm-node-heading"
        >
          DWDM topology — {nodeName}
        </h1>
        <a
          href="/dwdm"
          className="mt-1 text-xs text-sky-700 hover:underline"
          data-testid="dwdm-node-back"
        >
          ← Back to DWDM links
        </a>
      </div>
      <section className="mt-6">
        <DwdmCanvas nodes={rfNodes} edges={rfEdges} />
      </section>
    </main>
  );
}

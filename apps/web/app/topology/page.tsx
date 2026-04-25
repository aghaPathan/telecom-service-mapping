import nextDynamic from "next/dynamic";
import { requireRole } from "@/lib/rbac";
import { log } from "@/lib/logger";
import {
  parseTopologyQuery,
  applyUpeClustering,
  runEgoGraph,
  runCoreOverview,
  runTopologyPath,
  type GraphNodeDTO,
  type GraphEdgeDTO,
  type TopologyQuery,
} from "@/lib/topology";

export const dynamic = "force-dynamic";

function CanvasSkeleton() {
  return (
    <div className="flex h-[560px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500">
      Loading graph…
    </div>
  );
}

// reactflow needs `window` at import time. Mount the canvas client-only so
// the surrounding page stays server-rendered.
const TopologyCanvas = nextDynamic(
  () => import("./topology-canvas").then((m) => m.TopologyCanvas),
  { ssr: false, loading: () => <CanvasSkeleton /> },
);

type SearchParams = Record<string, string | string[] | undefined>;

function toSingle(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function normalizeParams(sp: SearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of Object.keys(sp)) {
    out[k] = toSingle(sp[k]);
  }
  return out;
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      data-testid="topology-error"
      className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
    >
      <div className="font-medium">Unable to render topology</div>
      <div className="mt-1">{message}</div>
    </div>
  );
}

function NoteBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="topology-note"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {children}
    </div>
  );
}

function EmptyPlaceholder() {
  return (
    <div
      data-testid="topology-empty"
      className="flex h-[320px] items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500"
    >
      No devices to render.
    </div>
  );
}

function refsToGraph(
  nodes: Array<{
    name: string;
    role: string;
    level: number;
    site: string | null;
  }>,
  edges: Array<{ a: string; b: string }>,
): { nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] } {
  const nodeDTOs: GraphNodeDTO[] = nodes.map((n) => ({
    id: n.name,
    type: "device",
    data: { name: n.name, role: n.role, level: n.level, site: n.site },
    position: { x: 0, y: 0 },
  }));
  const seen = new Set<string>();
  const edgeDTOs: GraphEdgeDTO[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue;
    const id = `${e.a}->${e.b}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edgeDTOs.push({ id, source: e.a, target: e.b });
  }
  return { nodes: nodeDTOs, edges: edgeDTOs };
}

// Drop transport (level 3.5) nodes and any edges that touched them.
// Applied BEFORE clustering so cluster counts don't get inflated by
// nodes that won't render.
function excludeTransport(g: {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}): { nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] } {
  const dropped = new Set<string>();
  const kept: GraphNodeDTO[] = [];
  for (const n of g.nodes) {
    const level = (n.data as { level?: number }).level;
    if (level === 3.5) {
      dropped.add(n.id);
      continue;
    }
    kept.push(n);
  }
  const edges = g.edges.filter(
    (e) => !dropped.has(e.source) && !dropped.has(e.target),
  );
  return { nodes: kept, edges };
}

function summarize(q: TopologyQuery): string {
  if (q.mode === "path")
    return `path: ${q.from.kind}:${q.from.value} → ${q.to.kind}:${q.to.value}`;
  if (q.mode === "ego") return `ego: ${q.around} (hops=${q.hops})`;
  return "core overview";
}

export default async function TopologyPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  await requireRole("viewer");
  const sp = normalizeParams(searchParams ?? {});

  let query: TopologyQuery;
  try {
    query = parseTopologyQuery(sp);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid query";
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Topology</h1>
        <div className="mt-6">
          <ErrorPanel message={message} />
        </div>
      </main>
    );
  }

  let graph: { nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] } = {
    nodes: [],
    edges: [],
  };
  let note: string | null = null;
  let failed = false;

  try {
    if (query.mode === "path") {
      const g = await runTopologyPath({
        from: { kind: query.from.kind, value: query.from.value },
        to: { kind: "device", value: query.to.value },
      });
      if (g.nodes.length === 0) {
        note = `No path from ${query.from.kind}:${query.from.value} to device:${query.to.value}.`;
      } else {
        graph = g;
      }
    } else if (query.mode === "ego") {
      const ego = await runEgoGraph({
        name: query.around,
        hops: query.hops,
      });
      if (ego.status === "start_not_found") {
        note = `Start device '${query.around}' not found.`;
      } else {
        graph = refsToGraph(ego.nodes, ego.edges);
      }
    } else {
      const core = await runCoreOverview();
      graph = refsToGraph(core.nodes, core.edges);
    }
  } catch (err) {
    failed = true;
    log("error", "topology_failed", {
      mode: query.mode,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (failed) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Topology</h1>
        <p className="mt-1 text-sm text-slate-500">{summarize(query)}</p>
        <div className="mt-6">
          <ErrorPanel message="Topology resolver failed. See server logs." />
        </div>
      </main>
    );
  }

  if (!query.include_transport) {
    graph = excludeTransport(graph);
  }
  const clustered = applyUpeClustering(
    graph.nodes,
    graph.edges,
    query.cluster,
  );

  const isEmpty = clustered.nodes.length === 0;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Topology</h1>
      <p className="mt-1 text-sm text-slate-500">{summarize(query)}</p>

      {note !== null ? (
        <div className="mt-4">
          <NoteBanner>{note}</NoteBanner>
        </div>
      ) : null}

      <section className="mt-6">
        {isEmpty ? (
          <EmptyPlaceholder />
        ) : (
          <TopologyCanvas
            nodes={clustered.nodes as unknown as import("reactflow").Node[]}
            edges={clustered.edges as unknown as import("reactflow").Edge[]}
          />
        )}
      </section>
    </main>
  );
}

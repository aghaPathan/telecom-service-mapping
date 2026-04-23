import { z } from "zod";
import { PathQuery, type Hop } from "@/lib/path";
import {
  UPE_ROLE,
  parseClusterParam,
  shouldCluster,
  type ClusterDevice,
} from "@/lib/cluster";
import type { DeviceNodeData, ClusterNodeData } from "@/components/graph/nodeTypes";

export const MAX_EGO_HOPS = 4;

// Accept boolean or the URL-param strings we use elsewhere. "1"/"true" -> true,
// everything else (incl. missing) -> false. Broader than downstream.ts because
// the /topology URL scheme uses "1"/"0" to match the `cluster` param.
function coerceBoolParam(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (v === "1" || v === "true") return true;
  return false;
}

type Endpoint = { kind: "device" | "service"; value: string };

export type TopologyQuery =
  | {
      mode: "path";
      from: Endpoint;
      to: Endpoint;
      cluster: boolean | null;
      include_transport: boolean;
    }
  | {
      mode: "ego";
      around: string;
      hops: number;
      cluster: boolean | null;
      include_transport: boolean;
    }
  | {
      mode: "core";
      cluster: boolean | null;
      include_transport: boolean;
    };

function asStringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseTopologyQuery(input: unknown): TopologyQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const from = asStringOrUndef(raw.from);
  const to = asStringOrUndef(raw.to);
  const around = asStringOrUndef(raw.around);

  const cluster = parseClusterParam(asStringOrUndef(raw.cluster));
  const include_transport = coerceBoolParam(raw.include_transport);

  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) {
      throw new Error("path mode requires both 'from' and 'to'");
    }
    const fromParsed = PathQuery.parse({ from });
    const toParsed = PathQuery.parse({ from: to });
    return {
      mode: "path",
      from: fromParsed,
      to: toParsed,
      cluster,
      include_transport,
    };
  }

  if (around !== undefined) {
    const hopsSchema = z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_EGO_HOPS)
      .default(1);
    const hops = hopsSchema.parse(raw.hops ?? 1);
    return {
      mode: "ego",
      around,
      hops,
      cluster,
      include_transport,
    };
  }

  return { mode: "core", cluster, include_transport };
}

// ---------- Graph DTO ----------

export type GraphNodeDTO = {
  id: string;
  type: "device" | "cluster";
  data: DeviceNodeData | ClusterNodeData;
  position: { x: number; y: number };
};

export type GraphEdgeDTO = {
  id: string;
  source: string;
  target: string;
};

export function hopsToGraphDTO(hops: Hop[]): {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
} {
  const seen = new Set<string>();
  const nodes: GraphNodeDTO[] = [];
  for (const h of hops) {
    if (seen.has(h.name)) continue;
    seen.add(h.name);
    const data: DeviceNodeData = {
      name: h.name,
      role: h.role,
      level: h.level,
      site: h.site,
    };
    nodes.push({
      id: h.name,
      type: "device",
      data,
      position: { x: 0, y: 0 },
    });
  }

  const edges: GraphEdgeDTO[] = [];
  const seenEdges = new Set<string>();
  for (let i = 1; i < hops.length; i++) {
    const a = hops[i - 1]!;
    const b = hops[i]!;
    if (a.name === b.name) continue;
    const id = `${a.name}->${b.name}`;
    if (seenEdges.has(id)) continue;
    seenEdges.add(id);
    edges.push({ id, source: a.name, target: b.name });
  }

  return { nodes, edges };
}

// ---------- UPE clustering ----------

type AnyNode = {
  id: string;
  type: string;
  data: { name?: string; role?: string; level?: number | null; site?: string | null } & Record<string, unknown>;
  position: { x: number; y: number };
};

type AnyEdge = { id: string; source: string; target: string };

export function applyUpeClustering<N extends AnyNode, E extends AnyEdge>(
  nodes: N[],
  edges: E[],
  override: boolean | null,
): { nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] } {
  const bySite = new Map<string, N[]>();
  for (const n of nodes) {
    if (n.type !== "device") continue;
    if (n.data?.role !== UPE_ROLE) continue;
    const site = n.data?.site;
    if (!site) continue;
    const bucket = bySite.get(site);
    if (bucket) bucket.push(n);
    else bySite.set(site, [n]);
  }

  const sitesToCluster = new Set<string>();
  for (const [site, group] of bySite) {
    if (shouldCluster(group.length, override)) sitesToCluster.add(site);
  }

  if (sitesToCluster.size === 0) {
    return {
      nodes: nodes.map((n) => ({ ...n }) as unknown as GraphNodeDTO),
      edges: edges.map((e) => ({ ...e }) as GraphEdgeDTO),
    };
  }

  // Map clustered UPE id -> cluster node id for edge rewriting.
  const upeToCluster = new Map<string, string>();
  const clusterNodes: GraphNodeDTO[] = [];
  for (const site of sitesToCluster) {
    const group = bySite.get(site)!;
    const clusterId = `cluster:${site}`;
    const devices: ClusterDevice[] = group.map((n) => ({
      name: n.data.name ?? n.id,
      role: n.data.role ?? UPE_ROLE,
      level: typeof n.data.level === "number" ? n.data.level : 2,
      site,
      vendor: null,
    }));
    const clusterData: ClusterNodeData = {
      site,
      role: UPE_ROLE,
      count: group.length,
      devices: devices.map((d) => ({ name: d.name, role: d.role })),
    };
    clusterNodes.push({
      id: clusterId,
      type: "cluster",
      data: clusterData,
      position: { x: 0, y: 0 },
    });
    for (const n of group) upeToCluster.set(n.id, clusterId);
  }

  const keptNodes: GraphNodeDTO[] = nodes
    .filter((n) => !upeToCluster.has(n.id))
    .map((n) => ({ ...n }) as unknown as GraphNodeDTO);
  const outNodes = [...keptNodes, ...clusterNodes];

  const seenPairs = new Set<string>();
  const outEdges: GraphEdgeDTO[] = [];
  for (const e of edges) {
    const source = upeToCluster.get(e.source) ?? e.source;
    const target = upeToCluster.get(e.target) ?? e.target;
    if (source === target) continue;
    const key = `${source}${target}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    outEdges.push({ id: `${source}->${target}`, source, target });
  }

  return { nodes: outNodes, edges: outEdges };
}

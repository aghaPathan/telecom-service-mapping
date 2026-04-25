import { z } from "zod";
import { PathQuery, runPath, type Hop, type DeviceRef } from "@/lib/path";
import { getDriver } from "@/lib/neo4j";
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

// ---------- Neo4j resolvers: ego & core overview ----------

// Neo4j variable-length bounds cannot be parameterized — validate then
// interpolate. Mirrors MAX_PATH_HOPS pattern in lib/path.ts.
const EgoHops = z.number().int().min(1).max(MAX_EGO_HOPS);

// Duplicated toNum/toStrOrNull rather than importing from lib/path.ts —
// project convention (see cluster.ts, downstream.ts). Keep it local.
type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}
function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
function deviceRefFrom(n: Record<string, unknown>): DeviceRef {
  return {
    name: String(n.name),
    role: String(n.role ?? "Unknown"),
    level: toNum(n.level ?? 0),
    site: toStrOrNull(n.site),
    domain: toStrOrNull(n.domain),
  };
}

export type EgoResult =
  | {
      status: "ok";
      start: DeviceRef;
      nodes: DeviceRef[];
      edges: Array<{ a: string; b: string }>;
    }
  | { status: "start_not_found" };

export async function runEgoGraph(args: {
  name: string;
  hops: number;
}): Promise<EgoResult> {
  const hops = EgoHops.parse(args.hops);
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    // 0..hops reach (includes the start itself so single-node/island cases
    // return the start node with no edges). id(n) < id(m) dedupes undirected
    // pairs. Filter out null r from the (start)->self self-join.
    const res = await session.run(
      `MATCH (start:Device {name: $name})
       OPTIONAL MATCH (start)-[:CONNECTS_TO*0..${hops}]-(reached:Device)
       WITH start, collect(DISTINCT reached) AS ns
       UNWIND ns AS n
       OPTIONAL MATCH (n)-[r:CONNECTS_TO]-(m:Device)
         WHERE m IN ns AND id(n) < id(m)
       WITH start,
            ns,
            collect(DISTINCT CASE WHEN r IS NULL THEN null
                                  ELSE { a: startNode(r).name, b: endNode(r).name }
                             END) AS rawEdges
       RETURN start { .name, .role, .level, .site, .domain } AS start,
              [n IN ns WHERE n IS NOT NULL
                | n { .name, .role, .level, .site, .domain }] AS nodes,
              [e IN rawEdges WHERE e IS NOT NULL] AS edges`,
      { name: args.name },
    );

    if (res.records.length === 0) {
      return { status: "start_not_found" };
    }
    const rec = res.records[0]!;
    const startRaw = rec.get("start");
    if (startRaw == null) {
      return { status: "start_not_found" };
    }
    const start = deviceRefFrom(startRaw as Record<string, unknown>);
    const nodes = (rec.get("nodes") as Array<Record<string, unknown>>).map(
      deviceRefFrom,
    );
    const edges = (
      rec.get("edges") as Array<{ a: string; b: string }>
    ).map((e) => ({ a: String(e.a), b: String(e.b) }));
    return { status: "ok", start, nodes, edges };
  } finally {
    await session.close();
  }
}

// ---------- Topology path resolver ----------

export type TopologyPathInput = {
  from: { kind: "device" | "service"; value: string };
  to: { kind: "device"; value: string };
};

export async function runTopologyPath(
  input: TopologyPathInput,
): Promise<{ nodes: GraphNodeDTO[]; edges: GraphEdgeDTO[] }> {
  const path = await runPath({
    kind: input.from.kind,
    value: input.from.value,
    to: { value: input.to.value },
  });
  if (path.status !== "ok") {
    return { nodes: [], edges: [] };
  }
  return hopsToGraphDTO(path.hops);
}

export type CoreOverviewResult = {
  nodes: DeviceRef[];
  edges: Array<{ a: string; b: string }>;
};

// Filter cores by level=1, never by :Core label — the ingestor applies role
// strings from config/hierarchy.yaml verbatim as labels (uppercase "CORE").
// See CLAUDE.md pitfall.
export async function runCoreOverview(): Promise<CoreOverviewResult> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (core:Device) WHERE core.level = 1
       OPTIONAL MATCH (core)-[:CONNECTS_TO]-(nb:Device)
       WITH collect(DISTINCT core) + collect(DISTINCT nb) AS all
       UNWIND all AS n
       WITH collect(DISTINCT n) AS ns
       UNWIND ns AS n
       OPTIONAL MATCH (n)-[r:CONNECTS_TO]-(m:Device)
         WHERE m IN ns AND id(n) < id(m)
       WITH ns,
            collect(DISTINCT CASE WHEN r IS NULL THEN null
                                  ELSE { a: startNode(r).name, b: endNode(r).name }
                             END) AS rawEdges
       RETURN [n IN ns WHERE n IS NOT NULL
                | n { .name, .role, .level, .site, .domain }] AS nodes,
              [e IN rawEdges WHERE e IS NOT NULL] AS edges`,
    );

    if (res.records.length === 0) {
      return { nodes: [], edges: [] };
    }
    const rec = res.records[0]!;
    const nodes = (rec.get("nodes") as Array<Record<string, unknown>>).map(
      deviceRefFrom,
    );
    const edges = (
      rec.get("edges") as Array<{ a: string; b: string }>
    ).map((e) => ({ a: String(e.a), b: String(e.b) }));
    return { nodes, edges };
  } finally {
    await session.close();
  }
}

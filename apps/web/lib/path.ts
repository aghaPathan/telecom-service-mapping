import { z } from "zod";
import { getDriver } from "@/lib/neo4j";

// ---------- Input schema ----------

// `from` is a single string of the form `<kind>:<value>` where kind is one of
// "device" or "service". The value after the colon is trimmed and must be
// non-empty and <= 200 characters (same ceiling as the search query to keep
// URL + DB bounds consistent). We split on the FIRST colon so device/service
// names that themselves contain colons survive untouched.
const FROM_RE = /^(device|service):([\s\S]+)$/;

export const PathQuery = z
  .object({ from: z.string() })
  .transform((o, ctx) => {
    const m = FROM_RE.exec(o.from);
    if (!m) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "from must be 'device:<name>' or 'service:<cid>'",
      });
      return z.NEVER;
    }
    const kind = m[1] as "device" | "service";
    const value = m[2]!.trim();
    if (value.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value must not be empty",
      });
      return z.NEVER;
    }
    if (value.length > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value exceeds 200 chars",
      });
      return z.NEVER;
    }
    return { kind, value };
  });
export type PathQuery = z.infer<typeof PathQuery>;

export function parsePathQuery(input: unknown): PathQuery {
  return PathQuery.parse(input);
}

// ---------- Response schema ----------

export const Hop = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
  in_if: z.string().nullable(),
  out_if: z.string().nullable(),
});
export type Hop = z.infer<typeof Hop>;

const DeviceRef = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
});
export type DeviceRef = z.infer<typeof DeviceRef>;

const NoPathReason = z.enum([
  "island",
  "service_has_no_endpoint",
  "start_not_found",
]);

export const PathResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    length: z.number(),
    hops: z.array(Hop),
  }),
  z.object({
    status: z.literal("no_path"),
    reason: NoPathReason,
    unreached_at: DeviceRef.nullable(),
  }),
]);
export type PathResponse = z.infer<typeof PathResponse>;

// ---------- Cypher resolver ----------

type Nr = { toNumber: () => number };
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v && typeof (v as Nr).toNumber === "function") return (v as Nr).toNumber();
  return Number(v);
}

function toStrOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

type PathNode = {
  name: string;
  role: string;
  level: number;
  site: string | null;
  domain: string | null;
};

type PathEdge = {
  a: string; // start node name (as stored direction)
  b: string; // end node name
  a_if: string | null;
  b_if: string | null;
};

function nodeToPathNode(n: Record<string, unknown>): PathNode {
  return {
    name: String(n.name),
    role: String(n.role ?? "Unknown"),
    level: toNum(n.level ?? 0),
    site: toStrOrNull(n.site),
    domain: toStrOrNull(n.domain),
  };
}

function edgeToPathEdge(e: Record<string, unknown>): PathEdge {
  return {
    a: String(e.a),
    b: String(e.b),
    a_if: toStrOrNull(e.a_if),
    b_if: toStrOrNull(e.b_if),
  };
}

/** Given a node at index `i` in the path and its surrounding edges, pick the
 *  interface on each edge that faces `node`. Edges are stored directionally in
 *  Neo4j but traversed undirected here, so we must match by node name not
 *  position. */
function pickInOut(
  node: PathNode,
  prev: PathEdge | null,
  next: PathEdge | null,
): { in_if: string | null; out_if: string | null } {
  const faceOf = (edge: PathEdge): string | null => {
    if (edge.a === node.name) return edge.a_if;
    if (edge.b === node.name) return edge.b_if;
    return null;
  };
  return {
    in_if: prev ? faceOf(prev) : null,
    out_if: next ? faceOf(next) : null,
  };
}

export async function runPath(q: PathQuery): Promise<PathResponse> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    // 1. Resolve start device name.
    let startName: string | null = null;
    if (q.kind === "device") {
      const res = await session.run(
        `MATCH (d:Device {name: $name}) RETURN d.name AS name`,
        { name: q.value },
      );
      if (res.records.length === 0) {
        return { status: "no_path", reason: "start_not_found", unreached_at: null };
      }
      startName = String(res.records[0]!.get("name"));
    } else {
      // service: prefer TERMINATES_AT {role:'source'}, then 'dest'.
      const res = await session.run(
        `MATCH (s:Service {cid: $cid})
         OPTIONAL MATCH (s)-[src:TERMINATES_AT {role: 'source'}]->(dsrc:Device)
         OPTIONAL MATCH (s)-[dst:TERMINATES_AT {role: 'dest'}]->(ddst:Device)
         RETURN s.cid AS cid,
                dsrc.name AS src_name,
                ddst.name AS dst_name`,
        { cid: q.value },
      );
      const rec = res.records[0];
      if (!rec || rec.get("cid") == null) {
        return {
          status: "no_path",
          reason: "service_has_no_endpoint",
          unreached_at: null,
        };
      }
      const src = rec.get("src_name");
      const dst = rec.get("dst_name");
      if (src != null) startName = String(src);
      else if (dst != null) startName = String(dst);
      else {
        return {
          status: "no_path",
          reason: "service_has_no_endpoint",
          unreached_at: null,
        };
      }
    }

    // 2. shortestPath under monotonic non-increasing level predicate to any
    //    level-1 (Core) device. Traversed undirected (`-[:CONNECTS_TO]-`).
    const pathRes = await session.run(
      `MATCH (start:Device {name: $startName})
       MATCH (core:Device) WHERE core.level = 1
       WITH start, core
       MATCH p = shortestPath((start)-[:CONNECTS_TO*1..15]-(core))
       WHERE ALL(i IN range(0, length(p) - 1)
                 WHERE (nodes(p)[i]).level >= (nodes(p)[i + 1]).level)
       RETURN [n IN nodes(p) | n { .name, .role, .level, .site, .domain }] AS pathNodes,
              [r IN relationships(p) | {
                 a: startNode(r).name,
                 b: endNode(r).name,
                 a_if: r.a_if,
                 b_if: r.b_if
              }] AS pathEdges
       ORDER BY length(p) ASC
       LIMIT 1`,
      { startName },
    );

    if (pathRes.records.length > 0) {
      const rec = pathRes.records[0]!;
      const nodes = (rec.get("pathNodes") as Array<Record<string, unknown>>).map(
        nodeToPathNode,
      );
      const edges = (rec.get("pathEdges") as Array<Record<string, unknown>>).map(
        edgeToPathEdge,
      );
      const hops: Hop[] = nodes.map((n, i) => {
        const prev = i > 0 ? edges[i - 1]! : null;
        const next = i < edges.length ? edges[i]! : null;
        const { in_if, out_if } = pickInOut(n, prev, next);
        return { ...n, in_if, out_if };
      });
      return { status: "ok", length: edges.length, hops };
    }

    // 3. No path to core. Find the deepest (lowest level) reachable device
    //    under the same monotonic predicate; that is where the trace stalled.
    const islandRes = await session.run(
      `MATCH (start:Device {name: $startName})
       MATCH p = (start)-[:CONNECTS_TO*0..15]-(reached:Device)
       WHERE ALL(i IN range(0, length(p) - 1)
                 WHERE (nodes(p)[i]).level >= (nodes(p)[i + 1]).level)
       RETURN reached { .name, .role, .level } AS node
       ORDER BY reached.level ASC
       LIMIT 1`,
      { startName },
    );
    if (islandRes.records.length > 0) {
      const n = islandRes.records[0]!.get("node") as Record<string, unknown>;
      return {
        status: "no_path",
        reason: "island",
        unreached_at: {
          name: String(n.name),
          role: String(n.role ?? "Unknown"),
          level: toNum(n.level ?? 0),
        },
      };
    }

    // BFS returned nothing — fallback to the start device itself.
    const startRes = await session.run(
      `MATCH (d:Device {name: $startName})
       RETURN d { .name, .role, .level } AS node`,
      { startName },
    );
    if (startRes.records.length > 0) {
      const n = startRes.records[0]!.get("node") as Record<string, unknown>;
      return {
        status: "no_path",
        reason: "island",
        unreached_at: {
          name: String(n.name),
          role: String(n.role ?? "Unknown"),
          level: toNum(n.level ?? 0),
        },
      };
    }
    return { status: "no_path", reason: "island", unreached_at: null };
  } finally {
    await session.close();
  }
}

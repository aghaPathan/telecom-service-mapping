import { z } from "zod";
import { getDriver } from "@/lib/neo4j";
import { toNum, toStrOrNull } from "@/lib/neo4j-coerce";

// ---------- Input schema ----------

// `from` is a single string of the form `<kind>:<value>` where kind is one of
// "device" or "service". The value after the colon is trimmed and must be
// non-empty and <= 200 characters (same ceiling as the search query to keep
// URL + DB bounds consistent). We split on the FIRST colon so device/service
// names that themselves contain colons survive untouched.
const FROM_RE = /^(device|service):([\s\S]+)$/;
const TO_RE = /^device:([\s\S]+)$/;

export const PathQuery = z
  .object({ from: z.string(), to: z.string().optional() })
  .transform((o, ctx) => {
    const fm = FROM_RE.exec(o.from);
    if (!fm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "from must be 'device:<name>' or 'service:<cid>'" });
      return z.NEVER;
    }
    const kind = fm[1] as "device" | "service";
    const value = fm[2]!.trim();
    if (value.length === 0 || value.length > 200) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value invalid" });
      return z.NEVER;
    }
    let to: { value: string } | undefined;
    if (o.to !== undefined) {
      const tm = TO_RE.exec(o.to);
      if (!tm) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to must be 'device:<name>'" });
        return z.NEVER;
      }
      const tv = tm[1]!.trim();
      if (tv.length === 0 || tv.length > 200) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to value invalid" });
        return z.NEVER;
      }
      to = { value: tv };
    }
    return { kind, value, to };
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
  // Edge weight ENTERING this hop (null for first hop and whenever the
  // inbound edge has no observed ISIS cost). PR 1 always emits null until
  // PR 2 populates :CONNECTS_TO.weight from ClickHouse.
  edge_weight_in: z.number().nullable(),
});
export type Hop = z.infer<typeof Hop>;

export const DeviceRef = z.object({
  name: z.string(),
  role: z.string(),
  level: z.number(),
  site: z.string().nullable(),
  domain: z.string().nullable(),
});
export type DeviceRef = z.infer<typeof DeviceRef>;

export const NoPathReasonSchema = z.enum([
  "island",
  "service_has_no_endpoint",
  "start_not_found",
]);
export type NoPathReason = z.infer<typeof NoPathReasonSchema>;

export const PathResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    length: z.number(),
    // True iff every edge on the chosen path had a non-null weight
    // (weighted Dijkstra ran); false iff hop-count fallback fired.
    weighted: z.boolean(),
    total_weight: z.number().nullable(),
    hops: z.array(Hop),
  }),
  z.object({
    status: z.literal("no_path"),
    reason: NoPathReasonSchema,
    unreached_at: DeviceRef.nullable(),
  }),
]);
export type PathResponse = z.infer<typeof PathResponse>;

// ---------- Cypher resolver ----------

// MAX_PATH_HOPS is a compile-time constant — Neo4j doesn't allow parameters
// inside variable-length relationship bounds, so string interpolation is
// the only option. Never make this configurable via env without validation.
// 2× the deepest hierarchy level (5) with headroom for ring detours.
const MAX_PATH_HOPS = 15;

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
  weight: number | null;
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
    weight: e.weight == null ? null : toNum(e.weight),
  };
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

function pickInboundWeight(
  node: PathNode,
  prev: PathEdge | null,
): number | null {
  if (!prev) return null;
  return prev.weight;
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
    let startDev: DeviceRef | null = null;
    if (q.kind === "device") {
      const res = await session.run(
        `MATCH (d:Device {name: $name})
         RETURN d { .name, .role, .level, .site, .domain } AS node`,
        { name: q.value },
      );
      if (res.records.length === 0) {
        return { status: "no_path", reason: "start_not_found", unreached_at: null };
      }
      startDev = deviceRefFrom(
        res.records[0]!.get("node") as Record<string, unknown>,
      );
      startName = startDev.name;
      // If the start device is itself a Core (level 1), shortestPath with
      // minimum 1 hop finds no path; short-circuit to a zero-hop result.
      if (startDev.level === 1) {
        return {
          status: "ok",
          length: 0,
          weighted: true,
          total_weight: 0,
          hops: [{ ...startDev, in_if: null, out_if: null, edge_weight_in: null }],
        };
      }
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

    // 2a. Device-to-device branch. Resolve target, compute corridor
    //     [min(src,tgt).level - 1, max(src,tgt).level + 1] and enumerate
    //     paths whose every node falls inside it. Same-level endpoints get a
    //     one-level detour above and below (avoids zig-zag through core);
    //     cross-level endpoints collapse the corridor to the existing
    //     monotonic envelope. Uses set-level null aggregation identical to
    //     the to-core search so a single non-weighted candidate forces the
    //     whole result to weighted=false.
    if (q.to !== undefined) {
      const tgtRes = await session.run(
        `MATCH (d:Device {name: $name})
         RETURN d { .name, .role, .level, .site, .domain } AS node`,
        { name: q.to.value },
      );
      if (tgtRes.records.length === 0) {
        // Reuse start_not_found for "target device not found" — semantically
        // a missing endpoint, not a topology disconnect. PathView's
        // reasonLabel renders this as "Device not found", which is accurate
        // for a d2d query whose `to` device doesn't exist.
        return { status: "no_path", reason: "start_not_found", unreached_at: null };
      }
      const tgtDev = deviceRefFrom(
        tgtRes.records[0]!.get("node") as Record<string, unknown>,
      );
      let srcLevel: number;
      if (startDev != null) {
        srcLevel = startDev.level;
      } else {
        const srcRes = await session.run(
          `MATCH (d:Device {name: $name})
           RETURN d.level AS level`,
          { name: startName },
        );
        if (srcRes.records.length === 0) {
          return { status: "no_path", reason: "start_not_found", unreached_at: null };
        }
        srcLevel = toNum(srcRes.records[0]!.get("level") ?? 0);
      }
      const tgtLevel = tgtDev.level;
      const loLevel = Math.min(srcLevel, tgtLevel) - 1;
      const hiLevel = Math.max(srcLevel, tgtLevel) + 1;

      const d2dRes = await session.run(
        `MATCH (start:Device {name: $startName})
         MATCH (tgt:Device {name: $tgtName})
         WITH start, tgt
         MATCH p = (start)-[:CONNECTS_TO*1..${MAX_PATH_HOPS}]-(tgt)
         WHERE ALL(n IN nodes(p) WHERE n.level >= $loLevel AND n.level <= $hiLevel)
         WITH p,
              [r IN relationships(p) | r.weight] AS ws,
              length(p) AS hops
         WITH p, hops,
              CASE WHEN any(w IN ws WHERE w IS NULL)
                   THEN null
                   ELSE reduce(t = 0.0, w IN ws | t + w)
              END AS total_weight
         WITH collect({p: p, hops: hops, total_weight: total_weight}) AS cands
         WITH cands, any(c IN cands WHERE c.total_weight IS NULL) AS anyUnweighted
         UNWIND cands AS c
         WITH c, anyUnweighted,
              CASE WHEN anyUnweighted THEN null ELSE c.total_weight END AS effective_weight
         RETURN [n IN nodes(c.p) | n { .name, .role, .level, .site, .domain }] AS pathNodes,
                [r IN relationships(c.p) | {
                   a: startNode(r).name,
                   b: endNode(r).name,
                   a_if: r.a_if,
                   b_if: r.b_if,
                   weight: r.weight
                }] AS pathEdges,
                effective_weight AS total_weight,
                c.hops AS hops
         ORDER BY
           CASE WHEN total_weight IS NULL THEN 1 ELSE 0 END ASC,
           total_weight ASC,
           hops ASC
         LIMIT 1`,
        { startName, tgtName: q.to.value, loLevel, hiLevel },
      );

      if (d2dRes.records.length === 0) {
        return { status: "no_path", reason: "island", unreached_at: tgtDev };
      }
      const rec = d2dRes.records[0]!;
      const pathNodes = (
        rec.get("pathNodes") as Array<Record<string, unknown>>
      ).map(nodeToPathNode);
      const pathEdges = (
        rec.get("pathEdges") as Array<Record<string, unknown>>
      ).map(edgeToPathEdge);
      const totalWeightRaw = rec.get("total_weight");
      const totalWeight = totalWeightRaw == null ? null : toNum(totalWeightRaw);
      const weighted = totalWeight != null;
      const hops: Hop[] = pathNodes.map((n, i) => {
        const prev = i > 0 ? pathEdges[i - 1]! : null;
        const next = i < pathEdges.length ? pathEdges[i]! : null;
        const { in_if, out_if } = pickInOut(n, prev, next);
        return {
          ...n,
          in_if,
          out_if,
          edge_weight_in: weighted ? pickInboundWeight(n, prev) : null,
        };
      });
      return {
        status: "ok",
        length: pathEdges.length,
        weighted,
        total_weight: totalWeight,
        hops,
      };
    }

    // 2. Enumerate all monotonic paths to any Core, compute weighted total per
    //    candidate (null if ANY edge on that path lacks weight). If ANY
    //    candidate in the set is partially weighted, the entire set falls back
    //    to min-hop and total_weight is reported null; otherwise pick the
    //    min-total-weight candidate. Traversal is undirected.
    //    NOTE: full enumeration (not shortestPath) is required so a longer
    //    fully-weighted path can outrank a shorter heavy one. Same perf class
    //    as the island fallback below (see TODO #9-perf).
    const pathRes = await session.run(
      `MATCH (start:Device {name: $startName})
       MATCH (core:Device) WHERE core.level = 1
       WITH start, core
       MATCH p = (start)-[:CONNECTS_TO*1..${MAX_PATH_HOPS}]-(core)
       WHERE ALL(i IN range(0, length(p) - 1)
                 WHERE (nodes(p)[i]).level >= (nodes(p)[i + 1]).level)
       WITH p,
            [r IN relationships(p) | r.weight] AS ws,
            length(p) AS hops
       WITH p, hops,
            CASE WHEN any(w IN ws WHERE w IS NULL)
                 THEN null
                 ELSE reduce(t = 0.0, w IN ws | t + w)
            END AS total_weight
       WITH collect({p: p, hops: hops, total_weight: total_weight}) AS cands
       WITH cands, any(c IN cands WHERE c.total_weight IS NULL) AS anyUnweighted
       UNWIND cands AS c
       WITH c, anyUnweighted,
            CASE WHEN anyUnweighted THEN null ELSE c.total_weight END AS effective_weight
       RETURN [n IN nodes(c.p) | n { .name, .role, .level, .site, .domain }] AS pathNodes,
              [r IN relationships(c.p) | {
                 a: startNode(r).name,
                 b: endNode(r).name,
                 a_if: r.a_if,
                 b_if: r.b_if,
                 weight: r.weight
              }] AS pathEdges,
              effective_weight AS total_weight,
              c.hops AS hops
       ORDER BY
         CASE WHEN total_weight IS NULL THEN 1 ELSE 0 END ASC,
         total_weight ASC,
         hops ASC
       LIMIT 1`,
      { startName },
    );

    if (pathRes.records.length > 0) {
      const rec = pathRes.records[0]!;
      const pathNodes = (
        rec.get("pathNodes") as Array<Record<string, unknown>>
      ).map(nodeToPathNode);
      const pathEdges = (
        rec.get("pathEdges") as Array<Record<string, unknown>>
      ).map(edgeToPathEdge);
      const totalWeightRaw = rec.get("total_weight");
      const totalWeight = totalWeightRaw == null ? null : toNum(totalWeightRaw);
      const weighted = totalWeight != null;
      const hops: Hop[] = pathNodes.map((n, i) => {
        const prev = i > 0 ? pathEdges[i - 1]! : null;
        const next = i < pathEdges.length ? pathEdges[i]! : null;
        const { in_if, out_if } = pickInOut(n, prev, next);
        return {
          ...n,
          in_if,
          out_if,
          edge_weight_in: weighted ? pickInboundWeight(n, prev) : null,
        };
      });
      return {
        status: "ok",
        length: pathEdges.length,
        weighted,
        total_weight: totalWeight,
        hops,
      };
    }

    // 3. No path to core. Find the deepest (lowest level) reachable device
    //    under the same monotonic predicate; that is where the trace stalled.
    // TODO(#9-perf): this enumerates all monotonic paths for the island case — acceptable on the 50-row fixture; profile against production graph before high-fanout deployment.
    const islandRes = await session.run(
      `MATCH (start:Device {name: $startName})
       MATCH p = (start)-[:CONNECTS_TO*0..${MAX_PATH_HOPS}]-(reached:Device)
       WHERE ALL(i IN range(0, length(p) - 1)
                 WHERE (nodes(p)[i]).level >= (nodes(p)[i + 1]).level)
       RETURN reached { .name, .role, .level, .site, .domain } AS node
       ORDER BY reached.level ASC
       LIMIT 1`,
      { startName },
    );
    if (islandRes.records.length > 0) {
      const n = islandRes.records[0]!.get("node") as Record<string, unknown>;
      return {
        status: "no_path",
        reason: "island",
        unreached_at: deviceRefFrom(n),
      };
    }

    // BFS returned nothing — fallback to the start device itself.
    const startRes = await session.run(
      `MATCH (d:Device {name: $startName})
       RETURN d { .name, .role, .level, .site, .domain } AS node`,
      { startName },
    );
    if (startRes.records.length > 0) {
      const n = startRes.records[0]!.get("node") as Record<string, unknown>;
      return {
        status: "no_path",
        reason: "island",
        unreached_at: deviceRefFrom(n),
      };
    }
    return { status: "no_path", reason: "island", unreached_at: null };
  } finally {
    await session.close();
  }
}

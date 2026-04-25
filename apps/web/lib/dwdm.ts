import { getDriver } from "@/lib/neo4j";
import { toNum, toStrOrNull } from "@/lib/neo4j-coerce";

// ---------- DTOs ----------

export type DwdmRow = {
  a_name: string;
  a_role: string | null;
  a_level: number | null;
  b_name: string;
  b_role: string | null;
  b_level: number | null;
  ring: string | null;
  span_name: string | null;
  snfn_cids: string[];
  mobily_cids: string[];
  src_interface: string | null;
  dst_interface: string | null;
};

export type NodeDto = {
  name: string;
  role: string | null;
  level: number | null;
  site: string | null;
  domain: string | null;
};

export type EdgeDto = {
  a: string;
  b: string;
  ring: string | null;
  span_name: string | null;
  snfn_cids: string[];
  mobily_cids: string[];
  src_interface: string | null;
  dst_interface: string | null;
};

// ---------- Filter shape ----------

export type ListDwdmFilter = {
  device_a?: string;
  device_b?: string;
  ring?: string;
  span_name?: string;
};

// ---------- Helpers ----------

// Cap server-side. Pure presentation guard — the page only renders 1000 rows.
const LIST_LIMIT = 1000;

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (x == null) continue;
    out.push(String(x));
  }
  return out;
}

function toLevelOrNull(v: unknown): number | null {
  if (v == null) return null;
  return toNum(v);
}

function nodeFrom(n: Record<string, unknown>): NodeDto {
  return {
    name: String(n.name),
    role: toStrOrNull(n.role),
    level: toLevelOrNull(n.level),
    site: toStrOrNull(n.site),
    domain: toStrOrNull(n.domain),
  };
}

function edgeFrom(e: Record<string, unknown>): EdgeDto {
  return {
    a: String(e.a),
    b: String(e.b),
    ring: toStrOrNull(e.ring),
    span_name: toStrOrNull(e.span_name),
    snfn_cids: toStringArray(e.snfn_cids),
    mobily_cids: toStringArray(e.mobily_cids),
    src_interface: toStrOrNull(e.src_interface),
    dst_interface: toStrOrNull(e.dst_interface),
  };
}

// ---------- Resolvers ----------

/**
 * Flat row listing for the /dwdm table. All filter values are case-insensitive
 * substring matches (`toLower(prop) CONTAINS toLower($q)`). `device_a` and
 * `device_b` match against EITHER endpoint name — direction isn't meaningful
 * to the operator since :DWDM_LINK is treated as undirected. Ordered by
 * (a.name, b.name) for stability. Capped at LIST_LIMIT rows.
 */
export async function listDwdmLinks(
  filter: ListDwdmFilter,
): Promise<DwdmRow[]> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    // Stable canonical ordering: enforce a.name <= b.name in the projection
    // (NOT the MATCH) so the row order doesn't depend on stored direction.
    // device_a / device_b filter against either endpoint — operators don't
    // know which side is canonical and shouldn't have to.
    const res = await session.run(
      `MATCH (a:Device)-[r:DWDM_LINK]-(b:Device)
       WHERE a.name < b.name
         AND ($device_a IS NULL
              OR toLower(a.name) CONTAINS toLower($device_a)
              OR toLower(b.name) CONTAINS toLower($device_a))
         AND ($device_b IS NULL
              OR toLower(a.name) CONTAINS toLower($device_b)
              OR toLower(b.name) CONTAINS toLower($device_b))
         AND ($ring IS NULL
              OR (r.ring IS NOT NULL
                  AND toLower(r.ring) CONTAINS toLower($ring)))
         AND ($span_name IS NULL
              OR (r.span_name IS NOT NULL
                  AND toLower(r.span_name) CONTAINS toLower($span_name)))
       RETURN a.name AS a_name, a.role AS a_role, a.level AS a_level,
              b.name AS b_name, b.role AS b_role, b.level AS b_level,
              r.ring AS ring, r.span_name AS span_name,
              r.snfn_cids AS snfn_cids, r.mobily_cids AS mobily_cids,
              r.src_interface AS src_interface,
              r.dst_interface AS dst_interface
       ORDER BY a.name, b.name
       LIMIT ${LIST_LIMIT}`,
      {
        device_a: filter.device_a ?? null,
        device_b: filter.device_b ?? null,
        ring: filter.ring ?? null,
        span_name: filter.span_name ?? null,
      },
    );

    return res.records.map((rec) => ({
      a_name: String(rec.get("a_name")),
      a_role: toStrOrNull(rec.get("a_role")),
      a_level: toLevelOrNull(rec.get("a_level")),
      b_name: String(rec.get("b_name")),
      b_role: toStrOrNull(rec.get("b_role")),
      b_level: toLevelOrNull(rec.get("b_level")),
      ring: toStrOrNull(rec.get("ring")),
      span_name: toStrOrNull(rec.get("span_name")),
      snfn_cids: toStringArray(rec.get("snfn_cids")),
      mobily_cids: toStringArray(rec.get("mobily_cids")),
      src_interface: toStrOrNull(rec.get("src_interface")),
      dst_interface: toStrOrNull(rec.get("dst_interface")),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Sub-graph of the named device + its :DWDM_LINK neighbours, plus the
 * incident DWDM edges. Match is undirected. Returns `{nodes:[], edges:[]}`
 * when the device is unknown — never throws.
 */
export async function getNodeDwdm(
  nodeName: string,
): Promise<{ nodes: NodeDto[]; edges: EdgeDto[] }> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (start:Device {name: $name})
       OPTIONAL MATCH (start)-[r:DWDM_LINK]-(nb:Device)
       WITH start, collect(DISTINCT nb) AS nbs,
            collect(DISTINCT CASE WHEN r IS NULL THEN null ELSE {
              a: startNode(r).name,
              b: endNode(r).name,
              ring: r.ring,
              span_name: r.span_name,
              snfn_cids: r.snfn_cids,
              mobily_cids: r.mobily_cids,
              src_interface: r.src_interface,
              dst_interface: r.dst_interface
            } END) AS rawEdges
       RETURN start { .name, .role, .level, .site, .domain } AS start,
              [n IN nbs WHERE n IS NOT NULL
                | n { .name, .role, .level, .site, .domain }] AS nbs,
              [e IN rawEdges WHERE e IS NOT NULL] AS edges`,
      { name: nodeName },
    );

    if (res.records.length === 0) {
      return { nodes: [], edges: [] };
    }
    const rec = res.records[0]!;
    const startRaw = rec.get("start");
    if (startRaw == null) {
      return { nodes: [], edges: [] };
    }
    const start = nodeFrom(startRaw as Record<string, unknown>);
    const neighbours = (rec.get("nbs") as Array<Record<string, unknown>>).map(
      nodeFrom,
    );
    const edges = (rec.get("edges") as Array<Record<string, unknown>>).map(
      edgeFrom,
    );
    return { nodes: [start, ...neighbours], edges };
  } finally {
    await session.close();
  }
}

/**
 * Sub-graph of all :DWDM_LINK edges where `r.ring = $ring`, plus their
 * endpoint devices. Empty result -> `{nodes:[], edges:[]}` (does not throw).
 */
export async function getRingDwdm(
  ringName: string,
): Promise<{ nodes: NodeDto[]; edges: EdgeDto[] }> {
  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (a:Device)-[r:DWDM_LINK]-(b:Device)
       WHERE r.ring = $ring
       WITH collect(DISTINCT r) AS rs,
            collect(DISTINCT a) + collect(DISTINCT b) AS allNodes
       UNWIND allNodes AS n
       WITH rs, collect(DISTINCT n) AS ns
       RETURN [n IN ns | n { .name, .role, .level, .site, .domain }] AS nodes,
              [r IN rs | {
                a: startNode(r).name,
                b: endNode(r).name,
                ring: r.ring,
                span_name: r.span_name,
                snfn_cids: r.snfn_cids,
                mobily_cids: r.mobily_cids,
                src_interface: r.src_interface,
                dst_interface: r.dst_interface
              }] AS edges`,
      { ring: ringName },
    );

    if (res.records.length === 0) {
      return { nodes: [], edges: [] };
    }
    const rec = res.records[0]!;
    const nodesRaw = rec.get("nodes") as Array<Record<string, unknown>> | null;
    const edgesRaw = rec.get("edges") as Array<Record<string, unknown>> | null;
    if (!nodesRaw || nodesRaw.length === 0) {
      return { nodes: [], edges: [] };
    }
    return {
      nodes: nodesRaw.map(nodeFrom),
      edges: (edgesRaw ?? []).map(edgeFrom),
    };
  } finally {
    await session.close();
  }
}

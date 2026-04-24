/**
 * map-topology.ts — server-side helper for the /map split-panel topology column.
 *
 * Composition: site name → first (highest-level, i.e. lowest `level` value)
 * device at the site → ego graph (2 hops) → GraphNodeDTO[]/GraphEdgeDTO[].
 *
 * Returns null if no devices exist at the site (graceful empty-state).
 */
import { getDriver } from "@/lib/neo4j";
import { runEgoGraph, type GraphNodeDTO, type GraphEdgeDTO } from "@/lib/topology";

export type SiteTopoData = {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
};

/**
 * Look up the first device at `site` (lowest numeric level, then alpha name)
 * and return an ego-topology (2 hops) shaped as graph DTOs.
 *
 * Returns null when the site has no devices in Neo4j.
 */
export async function getSiteTopology(site: string): Promise<SiteTopoData | null> {
  const deviceName = await fetchFirstDeviceAtSite(site);
  if (deviceName === null) return null;

  const ego = await runEgoGraph({ name: deviceName, hops: 2 });
  if (ego.status === "start_not_found") return null;

  const nodeDTOs: GraphNodeDTO[] = ego.nodes.map((n) => ({
    id: n.name,
    type: "device",
    data: { name: n.name, role: n.role, level: n.level, site: n.site },
    position: { x: 0, y: 0 },
  }));

  const seen = new Set<string>();
  const edgeDTOs: GraphEdgeDTO[] = [];
  for (const e of ego.edges) {
    if (e.a === e.b) continue;
    const id = `${e.a}->${e.b}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edgeDTOs.push({ id, source: e.a, target: e.b });
  }

  return { nodes: nodeDTOs, edges: edgeDTOs };
}

async function fetchFirstDeviceAtSite(site: string): Promise<string | null> {
  const session = getDriver().session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(
      `MATCH (d:Device)-[:LOCATED_AT]->(s:Site {name: $site})
       RETURN d.name AS name
       ORDER BY coalesce(d.level, 99) ASC, d.name ASC
       LIMIT 1`,
      { site },
    );
    if (res.records.length === 0) return null;
    const val = res.records[0]!.get("name");
    return val == null ? null : String(val);
  } finally {
    await session.close();
  }
}

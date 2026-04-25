import type { Driver } from "neo4j-driver";
import { parseHostname } from "@tsm/db";
import type { DeviceProps, DwdmEdge, LinkProps } from "../dedup.js";
import type { ResolverConfig } from "../resolver.js";
import type { SiteCoords } from "../sites-coords.js";
import type {
  ServiceProps,
  TerminateEdge,
  ProtectedByEdge,
} from "../services.js";
import type { IsisCostRow } from "../source/isis-cost.js";

const BATCH_SIZE = 5000;

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Whitelist of known role names we'll accept as Neo4j secondary labels.
 * Built from the supplied hierarchy + the unknown label. Prevents anyone from
 * sneaking a malicious role string through YAML into a Cypher label position.
 */
function sanitizeRoleLabel(
  role: string,
  allowed: ReadonlySet<string>,
): string | null {
  if (!allowed.has(role)) return null;
  // Defense-in-depth: role labels must be simple identifiers only.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(role)) return null;
  return role;
}

function allowedRolesFromConfig(cfg: ResolverConfig): Set<string> {
  const s = new Set<string>();
  for (const entry of cfg.hierarchy.levels) {
    for (const r of entry.roles) s.add(r);
  }
  s.add(cfg.hierarchy.unknown_label);
  return s;
}

export type SitePortalRow = {
  name: string;
  category: string | null;
  url: string | null;
};

export type GraphWriteInput = {
  devices: readonly DeviceProps[];
  links: readonly LinkProps[];
  sites: readonly SitePortalRow[];
  /** Site code → geographic metadata, loaded from config/sites.yaml.
   * Applied in phase 5; sites with no entry keep lat/lng/region null. */
  siteCoords?: SiteCoords;
  services: readonly ServiceProps[];
  terminates: readonly TerminateEdge[];
  protections: readonly ProtectedByEdge[];
  /** :CID node properties — protection_cids already parsed via parseProtectionCids. */
  cids: readonly CidProps[];
  /** Deduped DWDM edges (from `dedupDwdmRows`). Direction is canonical lesser→greater. */
  dwdm_edges: readonly DwdmEdge[];
};

/**
 * Properties for a `:CID` node (V1 contract rules #20, #21, #28).
 * Caller transforms `RawCidRow` → `CidProps` by passing
 * `raw.protection_cid` through `parseProtectionCids`.
 */
export type CidProps = {
  cid: string;
  capacity: string | null;
  source: string | null;
  dest: string | null;
  bandwidth: string | null;
  protection_type: string | null;
  /** Already parsed via parseProtectionCids — never the raw 'nan' sentinel. */
  protection_cids: string[];
  mobily_cid: string | null;
  region: string | null;
};

export type GraphWriteCounts = {
  nodes: number;
  edges: number;
  sites: number;
  services: number;
  terminate_edges: number;
  located_at_edges: number;
  protected_by_edges: number;
  cid_nodes: number;
  dwdm_edges: number;
};

/**
 * Full-refresh writer: wipes :Device and :Service nodes (with DETACH DELETE
 * taking care of :Site relationships too — we also wipe orphan :Site nodes
 * whose only edges were LOCATED_AT). Then re-creates the full graph in
 * ordered phases so downstream relationships always find their endpoints.
 *
 * Phase ordering (documented per PRD "atomic-ish, one Neo4j session per phase"):
 *   1. wipe existing graph
 *   2. constraints + indexes (idempotent)
 *   3. devices (with role secondary labels)
 *   4. CONNECTS_TO edges
 *   5. sites (merge union of sitesportal + derived-from-device-name)
 *   6. LOCATED_AT edges
 *   7. services
 *   8. TERMINATES_AT edges
 *   9. PROTECTED_BY edges
 *  10. SW dynamic-leveling post-pass
 */
export async function writeGraph(
  driver: Driver,
  data: GraphWriteInput,
  resolverCfg: ResolverConfig,
): Promise<GraphWriteCounts> {
  // Phase 1: wipe Device + Service + orphan Site nodes.
  {
    const session = driver.session();
    try {
      await session.run("MATCH (d:Device) DETACH DELETE d");
      await session.run("MATCH (s:Service) DETACH DELETE s");
      await session.run("MATCH (s:Site) DETACH DELETE s");
      // :DWDM_LINK edges are removed by the :Device DETACH DELETE above.
      await session.run("MATCH (c:CID) DETACH DELETE c");
    } finally {
      await session.close();
    }
  }

  // Phase 2: constraints + indexes (all idempotent).
  {
    const session = driver.session();
    try {
      await session.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
      );
      await session.run(
        "CREATE CONSTRAINT site_name_unique IF NOT EXISTS FOR (s:Site) REQUIRE s.name IS UNIQUE",
      );
      await session.run(
        "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.cid IS UNIQUE",
      );
      await session.run(
        "CREATE CONSTRAINT cid_uniq IF NOT EXISTS FOR (c:CID) REQUIRE c.cid IS UNIQUE",
      );
      await session.run(
        "CREATE INDEX device_role IF NOT EXISTS FOR (d:Device) ON (d.role)",
      );
      await session.run(
        "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
      );
      await session.run(
        "CREATE INDEX device_domain IF NOT EXISTS FOR (d:Device) ON (d.domain)",
      );
      await session.run(
        "CREATE INDEX device_site IF NOT EXISTS FOR (d:Device) ON (d.site)",
      );
      await session.run(
        "CREATE INDEX device_vendor IF NOT EXISTS FOR (d:Device) ON (d.vendor)",
      );
      await session.run(
        "CREATE INDEX device_tags IF NOT EXISTS FOR (d:Device) ON (d.tags)",
      );
      await session.run(
        "CREATE INDEX service_mobily_cid IF NOT EXISTS FOR (s:Service) ON (s.mobily_cid)",
      );
      await session.run(
        "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
      );
    } finally {
      await session.close();
    }
  }

  // Phase 3: devices — grouped by role so we can safely bake the role into
  // a static secondary label. (Neo4j 5 cannot parameterize labels, so we
  // validate each role against a whitelist before interpolation.) Each
  // device also gets its derived `site` property (null when we can't
  // extract one from the name).
  const allowed = allowedRolesFromConfig(resolverCfg);
  const byRole = new Map<string, DeviceProps[]>();
  for (const d of data.devices) {
    const role = d.role ?? resolverCfg.hierarchy.unknown_label;
    const safe = sanitizeRoleLabel(role, allowed)
      ?? resolverCfg.hierarchy.unknown_label;
    const bucket = byRole.get(safe);
    if (bucket) bucket.push(d);
    else byRole.set(safe, [d]);
  }

  let nodes = 0;
  for (const [role, devices] of byRole) {
    for (const batch of chunk(devices, BATCH_SIZE)) {
      const payload = batch.map((d) => {
        // S15: hostname-derived vendor wins when available (canonical form
        // like "Nokia" / "Huawei"); fall back to whatever the source row
        // carried. parseHostname returns null when the third token isn't in
        // the configured vendor_token_map, so synthetic fixtures and any
        // hostnames that don't follow the `SITE-ROLE-VENDOR<SERIAL>`
        // convention keep their source-provided vendor unchanged.
        const parsed = parseHostname(d.name, resolverCfg.hostname);
        return {
          name: d.name,
          vendor: parsed.vendor ?? d.vendor,
          domain: d.domain,
          ip: d.ip,
          mac: d.mac,
          role,
          level: d.level ?? resolverCfg.hierarchy.unknown_level,
          site: parsed.site,
          tags: d.tags ?? [],
          service_description: d.service_description ?? null,
        };
      });
      const session = driver.session();
      try {
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $batch AS d
               MERGE (x:Device {name: d.name})
               SET x.vendor              = d.vendor,
                   x.domain              = d.domain,
                   x.ip                  = d.ip,
                   x.mac                 = d.mac,
                   x.role                = d.role,
                   x.level               = d.level,
                   x.site                = d.site,
                   x.tags                = d.tags,
                   x.service_description = d.service_description,
                   x:\`${role}\``,
            { batch: payload },
          ),
        );
        nodes += batch.length;
      } finally {
        await session.close();
      }
    }
  }

  // Phase 4: CONNECTS_TO links.
  let edges = 0;
  for (const batch of chunk(data.links, BATCH_SIZE)) {
    const session = driver.session();
    try {
      const payload = batch.map((l) => ({
        a: l.a,
        b: l.b,
        a_if: l.a_if,
        b_if: l.b_if,
        trunk: l.trunk,
        updated_at: l.updated_at.toISOString(),
      }));
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS l
             MATCH (a:Device {name: l.a})
             MATCH (b:Device {name: l.b})
             MERGE (a)-[r:CONNECTS_TO {a_if: l.a_if, b_if: l.b_if}]->(b)
             SET r.trunk = l.trunk,
                 r.updated_at = l.updated_at`,
          { batch: payload },
        ),
      );
      edges += batch.length;
    } finally {
      await session.close();
    }
  }

  // Phase 4b: :CID nodes (V1 contract rule #28 — MERGE-upsert by `cid`).
  const cid_nodes = await writeCidNodes(driver, data.cids);

  // Phase 4c: :DWDM_LINK edges. Endpoints MUST already exist as :Device — if
  // either side is missing (LLDP didn't see the DWDM box) the row is silently
  // skipped. The skip count is implicit: returned count < input length.
  const dwdm_edges = await writeDwdmEdges(driver, data.dwdm_edges);

  // Phase 5: sites — union of sitesportal rows and the sites derived from
  // device names. Portal rows supply category/url; derived-only sites get
  // nulls. Case-sensitive match on `name` (operator tooling is consistent
  // on casing within a deployment).
  const siteByName = new Map<string, SitePortalRow>();
  for (const s of data.sites) {
    if (!s.name) continue;
    siteByName.set(s.name, {
      name: s.name,
      category: s.category,
      url: s.url,
    });
  }
  for (const d of data.devices) {
    const site = parseHostname(d.name, resolverCfg.hostname).site;
    if (site === null) continue;
    if (!siteByName.has(site)) {
      siteByName.set(site, { name: site, category: null, url: null });
    }
  }
  // Enrich each site with geographic metadata from sites.yaml when the site
  // code matches. Sites without a YAML entry get null lat/lng/region —
  // harmless for non-GIS consumers, surfaced as "not on map" by the /map page.
  const coords = data.siteCoords;
  const sites = [...siteByName.values()].map((s) => {
    const c = coords?.get(s.name);
    return {
      name: s.name,
      category: s.category,
      url: s.url,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
      region: c?.region ?? null,
    };
  });
  for (const batch of chunk(sites, BATCH_SIZE)) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS s
             MERGE (x:Site {name: s.name})
             SET x.category = s.category,
                 x.url      = s.url,
                 x.lat      = s.lat,
                 x.lng      = s.lng,
                 x.region   = s.region`,
          { batch },
        ),
      );
    } finally {
      await session.close();
    }
  }

  // Phase 6: LOCATED_AT edges — only for devices whose derived site has a
  // matching :Site node (true for every derived site by construction; also
  // true if the device name's prefix matches a portal site).
  let located_at_edges = 0;
  const locatedPayload = data.devices
    .map((d) => ({
      name: d.name,
      site: parseHostname(d.name, resolverCfg.hostname).site,
    }))
    .filter((p): p is { name: string; site: string } => p.site !== null);
  for (const batch of chunk(locatedPayload, BATCH_SIZE)) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS r
             MATCH (d:Device {name: r.name})
             MATCH (s:Site   {name: r.site})
             MERGE (d)-[:LOCATED_AT]->(s)`,
          { batch },
        ),
      );
      located_at_edges += batch.length;
    } finally {
      await session.close();
    }
  }

  // Phase 7: services.
  for (const batch of chunk(data.services, BATCH_SIZE)) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS s
             MERGE (x:Service {cid: s.cid})
             SET x.mobily_cid      = s.mobily_cid,
                 x.bandwidth       = s.bandwidth,
                 x.protection_type = s.protection_type,
                 x.region          = s.region`,
          { batch },
        ),
      );
    } finally {
      await session.close();
    }
  }

  // Phase 8: TERMINATES_AT — drop edges whose endpoint device isn't in the
  // graph. The MATCH ... MERGE combination handles this implicitly (MERGE
  // on a MATCH miss does nothing), so we count on the caller's pre-drop
  // bookkeeping for "missing device" logging.
  let terminate_edges = 0;
  for (const batch of chunk(data.terminates, BATCH_SIZE)) {
    const session = driver.session();
    try {
      const res = await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS t
             MATCH (s:Service {cid: t.cid})
             MATCH (d:Device  {name: t.device})
             MERGE (s)-[r:TERMINATES_AT {role: t.role}]->(d)
             RETURN count(r) AS c`,
          { batch },
        ),
      );
      const c = res.records[0]?.get("c");
      terminate_edges += typeof c === "number" ? c : c?.toNumber?.() ?? 0;
    } finally {
      await session.close();
    }
  }

  // Phase 9: PROTECTED_BY edges (primary → backup).
  let protected_by_edges = 0;
  for (const batch of chunk(data.protections, BATCH_SIZE)) {
    const session = driver.session();
    try {
      const res = await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS p
             MATCH (primary:Service {cid: p.primary_cid})
             MATCH (backup:Service  {cid: p.backup_cid})
             MERGE (primary)-[r:PROTECTED_BY]->(backup)
             RETURN count(r) AS c`,
          { batch },
        ),
      );
      const c = res.records[0]?.get("c");
      protected_by_edges += typeof c === "number" ? c : c?.toNumber?.() ?? 0;
    } finally {
      await session.close();
    }
  }

  // Phase 10: SW dynamic-leveling post-pass.
  //
  // Uses `n.level` property (not hardcoded role labels) to determine topology:
  //   - Level 1 = Core tier (per hierarchy.yaml)
  //   - Level >= 4 = Access tier (per hierarchy.yaml)
  //
  // This replaces a V1-inherited label-hardcode (`n:CORE`, `n:RAN`, `n:Customer`)
  // that silently failed when the hierarchy used non-CORE/RAN/Customer role names
  // — a CLAUDE.md-flagged pitfall. Filtering by `n.level` is hierarchy-config-
  // agnostic and always correct regardless of what role names are configured.
  if (
    resolverCfg.hierarchy.sw_dynamic_leveling.enabled &&
    allowed.has("SW")
  ) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (sw:Device:SW)
           OPTIONAL MATCH (sw)-[:CONNECTS_TO]-(n:Device)
           WITH sw, collect(n) AS nbrs
           WITH sw,
                any(n IN nbrs WHERE n.level = 1) AS toCore,
                any(n IN nbrs WHERE n.level >= 4) AS toAccess
           SET sw.level = CASE
             WHEN toCore   THEN 2
             WHEN toAccess THEN 4
             ELSE 3
           END`,
        ),
      );
    } finally {
      await session.close();
    }
  }

  return {
    nodes,
    edges,
    sites: sites.length,
    services: data.services.length,
    terminate_edges,
    located_at_edges,
    protected_by_edges,
    cid_nodes,
    dwdm_edges,
  };
}

/**
 * Write `:CID` nodes via MERGE on `cid` (V1 contract rule #28 — idempotent
 * upsert). Returns the input length (each input row results in exactly one
 * MERGE, so the post-condition `MATCH (c:CID) RETURN count(c) = inputLength`
 * holds when called against a fresh DB or applied repeatedly with the same
 * `cid` keys).
 *
 * NEVER log row contents — fixture data here, but production CIDs are real
 * customer circuit IDs (CLAUDE.md data-sensitivity).
 */
export async function writeCidNodes(
  driver: Driver,
  cids: readonly CidProps[],
): Promise<number> {
  let count = 0;
  for (const batch of chunk(cids, BATCH_SIZE)) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS row
             MERGE (c:CID {cid: row.cid})
             SET c.capacity        = row.capacity,
                 c.source          = row.source,
                 c.dest            = row.dest,
                 c.bandwidth       = row.bandwidth,
                 c.protection_type = row.protection_type,
                 c.protection_cids = row.protection_cids,
                 c.mobily_cid      = row.mobily_cid,
                 c.region          = row.region`,
          { batch },
        ),
      );
      count += batch.length;
    } finally {
      await session.close();
    }
  }
  return count;
}

/**
 * Apply observed ISIS edge weights onto existing `:CONNECTS_TO` edges.
 *
 * Match is orientation-agnostic: both physical orientations of the LLDP edge
 * are checked against both orderings of the input row's interfaces. Edges
 * with no incoming row are NEVER touched — `weight=null` is impossible by
 * construction (the SET clause only fires when MATCH succeeds).
 *
 * Returns the number of `:CONNECTS_TO` edges that received an observed
 * weight (summed across batches). The count equals distinct edges only
 * when the caller has deduped input to one row per canonical pair (see
 * `canonicalizeIsisRows`); without that, A→B and B→A inputs for the same
 * physical edge each increment the count and the final weight is
 * last-write-wins.
 *
 * NEVER log row contents — production hostnames per CLAUDE.md
 * data-sensitivity rules.
 */
export async function writeIsisWeights(
  driver: Driver,
  rows: readonly IsisCostRow[],
): Promise<{ edges_matched: number }> {
  if (rows.length === 0) return { edges_matched: 0 };

  let edges_matched = 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    const session = driver.session();
    try {
      const payload = batch.map((r) => ({
        a: r.device_a_name,
        b: r.device_b_name,
        if_a: r.device_a_interface,
        if_b: r.device_b_interface,
        weight: r.weight,
        observed_at: r.observed_at.toISOString(),
      }));
      const res = await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS r
             MATCH (a:Device {name: r.a})-[e:CONNECTS_TO]-(b:Device {name: r.b})
             WHERE (e.a_if = r.if_a AND e.b_if = r.if_b)
                OR (e.a_if = r.if_b AND e.b_if = r.if_a)
             SET e.weight             = toFloat(r.weight),
                 e.weight_source      = 'observed',
                 e.weight_observed_at = datetime(r.observed_at)
             RETURN count(e) AS matched`,
          { batch: payload },
        ),
      );
      const m = res.records[0]?.get("matched");
      edges_matched +=
        typeof m === "number" ? m : m?.toNumber?.() ?? 0;
    } finally {
      await session.close();
    }
  }
  return { edges_matched };
}

/**
 * Write `:DWDM_LINK` edges between existing `:Device` nodes. Uses MATCH (not
 * MERGE) for both endpoints — if either side is missing the row is silently
 * skipped. Direction is canonical lesser→greater per `DwdmEdge.src/dst`.
 *
 * Returns the count of edges actually written (sum of `count(r)` per batch).
 */
export async function writeDwdmEdges(
  driver: Driver,
  edges: readonly DwdmEdge[],
): Promise<number> {
  let count = 0;
  for (const batch of chunk(edges, BATCH_SIZE)) {
    const session = driver.session();
    try {
      const payload = batch.map((e) => ({
        src: e.src,
        dst: e.dst,
        src_interface: e.src_interface,
        dst_interface: e.dst_interface,
        ring: e.ring,
        snfn_cids: e.snfn_cids,
        mobily_cids: e.mobily_cids,
        span_name: e.span_name,
      }));
      const res = await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS row
             MATCH (a:Device {name: row.src})
             MATCH (b:Device {name: row.dst})
             MERGE (a)-[r:DWDM_LINK]->(b)
             SET r.ring          = row.ring,
                 r.snfn_cids     = row.snfn_cids,
                 r.mobily_cids   = row.mobily_cids,
                 r.span_name     = row.span_name,
                 r.src_interface = row.src_interface,
                 r.dst_interface = row.dst_interface
             RETURN count(r) AS n`,
          { batch: payload },
        ),
      );
      const n = res.records[0]?.get("n");
      count += typeof n === "number" ? n : n?.toNumber?.() ?? 0;
    } finally {
      await session.close();
    }
  }
  return count;
}

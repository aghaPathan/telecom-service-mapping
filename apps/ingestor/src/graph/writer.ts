import type { Driver } from "neo4j-driver";
import type { DeviceProps, LinkProps } from "../dedup.js";
import type { ResolverConfig } from "../resolver.js";
import { deriveSiteFromDeviceName } from "../site.js";
import type {
  ServiceProps,
  TerminateEdge,
  ProtectedByEdge,
} from "../services.js";

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
  services: readonly ServiceProps[];
  terminates: readonly TerminateEdge[];
  protections: readonly ProtectedByEdge[];
};

export type GraphWriteCounts = {
  nodes: number;
  edges: number;
  sites: number;
  services: number;
  terminate_edges: number;
  located_at_edges: number;
  protected_by_edges: number;
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
      const payload = batch.map((d) => ({
        name: d.name,
        vendor: d.vendor,
        domain: d.domain,
        ip: d.ip,
        mac: d.mac,
        role,
        level: d.level ?? resolverCfg.hierarchy.unknown_level,
        site: deriveSiteFromDeviceName(d.name),
      }));
      const session = driver.session();
      try {
        await session.executeWrite((tx) =>
          tx.run(
            `UNWIND $batch AS d
               MERGE (x:Device {name: d.name})
               SET x.vendor = d.vendor,
                   x.domain = d.domain,
                   x.ip     = d.ip,
                   x.mac    = d.mac,
                   x.role   = d.role,
                   x.level  = d.level,
                   x.site   = d.site,
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
    const site = deriveSiteFromDeviceName(d.name);
    if (site === null) continue;
    if (!siteByName.has(site)) {
      siteByName.set(site, { name: site, category: null, url: null });
    }
  }
  const sites = [...siteByName.values()];
  for (const batch of chunk(sites, BATCH_SIZE)) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS s
             MERGE (x:Site {name: s.name})
             SET x.category = s.category,
                 x.url      = s.url`,
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
    .map((d) => ({ name: d.name, site: deriveSiteFromDeviceName(d.name) }))
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
                any(n IN nbrs WHERE n:CORE) AS toCore,
                any(n IN nbrs WHERE n:RAN OR n:Customer) AS toAccess
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
  };
}

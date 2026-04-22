import type { Driver } from "neo4j-driver";
import type { DeviceProps, LinkProps } from "../dedup.js";
import type { ResolverConfig } from "../resolver.js";

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

/**
 * Full-refresh writer: wipes all `:Device` nodes (and their relationships via
 * DETACH DELETE), ensures the uniqueness constraint exists, then re-creates
 * devices and links from the supplied dedup result. Finally applies a
 * topology-driven re-leveling pass for :SW nodes (if enabled in hierarchy).
 */
export async function writeGraph(
  driver: Driver,
  data: { devices: readonly DeviceProps[]; links: readonly LinkProps[] },
  resolverCfg: ResolverConfig,
): Promise<{ nodes: number; edges: number }> {
  // Phase 1: wipe.
  {
    const session = driver.session();
    try {
      await session.run("MATCH (d:Device) DETACH DELETE d");
    } finally {
      await session.close();
    }
  }

  // Phase 2: constraint (idempotent).
  {
    const session = driver.session();
    try {
      await session.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
      );
    } finally {
      await session.close();
    }
  }

  // Phase 3: devices — grouped by role so we can safely bake the role into
  // a static secondary label. (Neo4j 5 cannot parameterize labels, so we
  // validate each role against a whitelist before interpolation.)
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

  // Phase 4: links.
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

  // Phase 5: SW dynamic-leveling post-pass.
  // Only runs if hierarchy.sw_dynamic_leveling.enabled AND the hierarchy
  // actually knows about an SW role (skipping gracefully otherwise).
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
                any(n IN nbrs WHERE n:Ran OR n:Customer) AS toAccess
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

  return { nodes, edges };
}

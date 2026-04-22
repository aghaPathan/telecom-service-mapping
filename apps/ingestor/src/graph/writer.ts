import type { Driver } from "neo4j-driver";
import type { DeviceProps, LinkProps } from "../dedup.js";

const BATCH_SIZE = 5000;

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Full-refresh writer: wipes all `:Device` nodes (and their relationships via
 * DETACH DELETE), ensures the uniqueness constraint exists, then re-creates
 * devices and links from the supplied dedup result.
 *
 * We use batched `UNWIND … MERGE` statements (each batch is one implicit
 * transaction) rather than `CALL { … } IN TRANSACTIONS OF N ROWS` because the
 * latter requires auto-commit (implicit) transactions at the driver level
 * and fights with drivers run inside `session.executeWrite`. At MVP scale
 * (~100k rows) this is fine.
 */
export async function writeGraph(
  driver: Driver,
  data: { devices: readonly DeviceProps[]; links: readonly LinkProps[] },
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

  // Phase 3: devices.
  let nodes = 0;
  for (const batch of chunk(data.devices, BATCH_SIZE)) {
    const session = driver.session();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `UNWIND $batch AS d
             MERGE (x:Device {name: d.name})
             SET x.vendor = d.vendor,
                 x.domain = d.domain,
                 x.ip     = d.ip,
                 x.mac    = d.mac`,
          { batch },
        ),
      );
      nodes += batch.length;
    } finally {
      await session.close();
    }
  }

  // Phase 4: links.
  let edges = 0;
  for (const batch of chunk(data.links, BATCH_SIZE)) {
    const session = driver.session();
    try {
      // Neo4j driver needs primitives — hand it ISO strings for timestamps.
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

  return { nodes, edges };
}

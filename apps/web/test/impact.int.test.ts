import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for runImpact against a real Neo4j 5 container.
// Fixture nodes are prefixed `I5-` so this suite is namespace-isolated from
// other int tests if they ever share a container (currently they don't —
// each suite boots its own).

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

async function seed(driver: Driver) {
  const session = driver.session();
  try {
    await session.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    await session.run(
      "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
    );

    // Fixture mirrors downstream.int.test.ts A4- seed but with I5- prefix and
    // a `vendor` property on every node (required by runImpact projection).
    //
    //   I5-CORE1(1)
    //     ├─ I5-UPE1(2)
    //     │    └─ I5-CSG1(3)
    //     │         ├─ I5-MW1(3.5) ──┬─ I5-RAN1(4) ──── I5-CUST1..5(5)
    //     │         │                └─ I5-RAN2(4) ──── I5-CUST6..10(5)
    //     │         └─ I5-MW2(3.5) ──── I5-RAN3(4) ──── I5-CUST11..15(5)
    //     └─ I5-UPE2(2)
    //          ├─ I5-CSG2(3)
    //          └─ I5-CSG3(3)
    //          (I5-CSG2)-[:CONNECTS_TO]-(I5-CSG3)   <-- same-level peer edge,
    //                                                   must NOT be traversed.
    //   I5-ISLAND(3)                                  <-- no edges
    await session.run(
      `MERGE (core:Device {name:'I5-CORE1'}) SET core.role='CORE', core.level=1, core.site='S', core.domain='D', core.vendor='Cisco'
       MERGE (upe1:Device {name:'I5-UPE1'}) SET upe1.role='UPE', upe1.level=2, upe1.site='S', upe1.domain='D', upe1.vendor='Nokia'
       MERGE (upe2:Device {name:'I5-UPE2'}) SET upe2.role='UPE', upe2.level=2, upe2.site='S', upe2.domain='D', upe2.vendor='Nokia'
       MERGE (csg1:Device {name:'I5-CSG1'}) SET csg1.role='CSG', csg1.level=3, csg1.site='S', csg1.domain='D', csg1.vendor='Nokia'
       MERGE (csg2:Device {name:'I5-CSG2'}) SET csg2.role='CSG', csg2.level=3, csg2.site='S', csg2.domain='D', csg2.vendor='Nokia'
       MERGE (csg3:Device {name:'I5-CSG3'}) SET csg3.role='CSG', csg3.level=3, csg3.site='S', csg3.domain='D', csg3.vendor='Nokia'
       MERGE (mw1:Device  {name:'I5-MW1'})  SET mw1.role='MW',  mw1.level=3.5, mw1.site='S', mw1.domain='D', mw1.vendor=null
       MERGE (mw2:Device  {name:'I5-MW2'})  SET mw2.role='MW',  mw2.level=3.5, mw2.site='S', mw2.domain='D', mw2.vendor=null
       MERGE (ran1:Device {name:'I5-RAN1'}) SET ran1.role='RAN', ran1.level=4, ran1.site='S', ran1.domain='D', ran1.vendor='Ericsson'
       MERGE (ran2:Device {name:'I5-RAN2'}) SET ran2.role='RAN', ran2.level=4, ran2.site='S', ran2.domain='D', ran2.vendor='Ericsson'
       MERGE (ran3:Device {name:'I5-RAN3'}) SET ran3.role='RAN', ran3.level=4, ran3.site='S', ran3.domain='D', ran3.vendor='Ericsson'
       MERGE (island:Device {name:'I5-ISLAND'}) SET island.role='CSG', island.level=3, island.site='I', island.domain='D', island.vendor='Nokia'
       MERGE (core)-[:CONNECTS_TO]->(upe1)
       MERGE (core)-[:CONNECTS_TO]->(upe2)
       MERGE (upe1)-[:CONNECTS_TO]->(csg1)
       MERGE (csg1)-[:CONNECTS_TO]->(mw1)
       MERGE (csg1)-[:CONNECTS_TO]->(mw2)
       MERGE (mw1)-[:CONNECTS_TO]->(ran1)
       MERGE (mw1)-[:CONNECTS_TO]->(ran2)
       MERGE (mw2)-[:CONNECTS_TO]->(ran3)
       MERGE (upe2)-[:CONNECTS_TO]->(csg2)
       MERGE (upe2)-[:CONNECTS_TO]->(csg3)
       MERGE (csg2)-[:CONNECTS_TO]->(csg3)`,
    );

    // Customers — vendor='CPE'.
    await session.run(
      `UNWIND $rows AS row
       MERGE (c:Device {name: row.name})
       SET c.role='Customer', c.level=5, c.site='S', c.domain='D', c.vendor='CPE'
       WITH c, row
       MATCH (parent:Device {name: row.parent})
       MERGE (parent)-[:CONNECTS_TO]->(c)`,
      {
        rows: [
          ...[1, 2, 3, 4, 5].map((i) => ({
            name: `I5-CUST${i}`,
            parent: "I5-RAN1",
          })),
          ...[6, 7, 8, 9, 10].map((i) => ({
            name: `I5-CUST${i}`,
            parent: "I5-RAN2",
          })),
          ...[11, 12, 13, 14, 15].map((i) => ({
            name: `I5-CUST${i}`,
            parent: "I5-RAN3",
          })),
        ],
      },
    );
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  neo4jC = await new GenericContainer("neo4j:5-community")
    .withEnvironment({ NEO4J_AUTH: `${NEO_USER}/${NEO_PASS}` })
    .withExposedPorts(7687, 7474)
    .withWaitStrategy(Wait.forLogMessage(/Started\./))
    .withStartupTimeout(120_000)
    .start();

  const uri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;
  process.env.NEO4J_URI = uri;
  process.env.NEO4J_USER = NEO_USER;
  process.env.NEO4J_PASSWORD = NEO_PASS;

  adminDriver = neo4j.driver(uri, neo4j.auth.basic(NEO_USER, NEO_PASS));
  await seed(adminDriver);
}, 180_000);

afterAll(async () => {
  await adminDriver?.close();
  const { getDriver } = await import("@/lib/neo4j");
  try {
    await getDriver().close();
  } catch {
    /* already closed */
  }
  await neo4jC?.stop();
}, 60_000);

describe("runImpact against live Neo4j", () => {
  it("returns flat rows with hops + vendor for a seeded UPE", async () => {
    const { runImpact } = await import("@/lib/impact");
    const res = await runImpact({
      device: "I5-UPE1",
      max_depth: 10,
      include_transport: false,
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");

    // No MW rows when include_transport is false…
    expect(res.rows.find((r) => r.level === 3.5)).toBeUndefined();
    // …but RANs behind MW are still present (traversal goes THROUGH MW).
    expect(res.rows.find((r) => r.name === "I5-RAN1")).toBeDefined();

    const csg1 = res.rows.find((r) => r.name === "I5-CSG1")!;
    expect(csg1.hops).toBe(1);
    expect(csg1.vendor).toBe("Nokia");

    const ran1 = res.rows.find((r) => r.name === "I5-RAN1")!;
    expect(ran1.hops).toBe(3); // UPE1 -> CSG1 -> MW1 -> RAN1
    expect(ran1.vendor).toBe("Ericsson");

    // summary is grouped by (role, level) — CSGs, RANs, Customers present
    const roles = new Set(res.summary.map((g) => g.role));
    expect(roles.has("CSG")).toBe(true);
    expect(roles.has("RAN")).toBe(true);
    expect(roles.has("Customer")).toBe(true);
    expect(roles.has("MW")).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for runDownstream against a real Neo4j 5 container.
// Fixture nodes are prefixed `A4-` so this suite is namespace-isolated from
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

    // Fixture — see plan docs/plans/2026-04-22-downstream-blast-radius.md A4.
    //
    //   A4-CORE1(1)
    //     ├─ A4-UPE1(2)
    //     │    └─ A4-CSG1(3)
    //     │         ├─ A4-MW1(3.5) ──┬─ A4-RAN1(4) ──── A4-CUST1..5(5)
    //     │         │                └─ A4-RAN2(4) ──── A4-CUST6..10(5)
    //     │         └─ A4-MW2(3.5) ──── A4-RAN3(4) ──── A4-CUST11..15(5)
    //     └─ A4-UPE2(2)
    //          ├─ A4-CSG2(3)
    //          └─ A4-CSG3(3)
    //          (A4-CSG2)-[:CONNECTS_TO]-(A4-CSG3)   <-- same-level peer edge,
    //                                                   must NOT be traversed
    //                                                   downstream.
    //   A4-ISLAND(3)                                  <-- no edges
    await session.run(
      `MERGE (core:Device {name:'A4-CORE1'}) SET core.role='CORE', core.level=1, core.site='S', core.domain='D'
       MERGE (upe1:Device {name:'A4-UPE1'}) SET upe1.role='UPE', upe1.level=2, upe1.site='S', upe1.domain='D'
       MERGE (upe2:Device {name:'A4-UPE2'}) SET upe2.role='UPE', upe2.level=2, upe2.site='S', upe2.domain='D'
       MERGE (csg1:Device {name:'A4-CSG1'}) SET csg1.role='CSG', csg1.level=3, csg1.site='S', csg1.domain='D'
       MERGE (csg2:Device {name:'A4-CSG2'}) SET csg2.role='CSG', csg2.level=3, csg2.site='S', csg2.domain='D'
       MERGE (csg3:Device {name:'A4-CSG3'}) SET csg3.role='CSG', csg3.level=3, csg3.site='S', csg3.domain='D'
       MERGE (mw1:Device  {name:'A4-MW1'})  SET mw1.role='MW',  mw1.level=3.5, mw1.site='S', mw1.domain='D'
       MERGE (mw2:Device  {name:'A4-MW2'})  SET mw2.role='MW',  mw2.level=3.5, mw2.site='S', mw2.domain='D'
       MERGE (ran1:Device {name:'A4-RAN1'}) SET ran1.role='RAN', ran1.level=4, ran1.site='S', ran1.domain='D'
       MERGE (ran2:Device {name:'A4-RAN2'}) SET ran2.role='RAN', ran2.level=4, ran2.site='S', ran2.domain='D'
       MERGE (ran3:Device {name:'A4-RAN3'}) SET ran3.role='RAN', ran3.level=4, ran3.site='S', ran3.domain='D'
       MERGE (island:Device {name:'A4-ISLAND'}) SET island.role='CSG', island.level=3, island.site='I', island.domain='D'
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

    // Customers — seed in batch via UNWIND so the MERGEs are concise.
    await session.run(
      `UNWIND $rows AS row
       MERGE (c:Device {name: row.name})
       SET c.role='Customer', c.level=5, c.site='S', c.domain='D'
       WITH c, row
       MATCH (parent:Device {name: row.parent})
       MERGE (parent)-[:CONNECTS_TO]->(c)`,
      {
        rows: [
          ...[1, 2, 3, 4, 5].map((i) => ({
            name: `A4-CUST${i}`,
            parent: "A4-RAN1",
          })),
          ...[6, 7, 8, 9, 10].map((i) => ({
            name: `A4-CUST${i}`,
            parent: "A4-RAN2",
          })),
          ...[11, 12, 13, 14, 15].map((i) => ({
            name: `A4-CUST${i}`,
            parent: "A4-RAN3",
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

describe("runDownstream against live Neo4j", () => {
  it("default (no MW): UPE1 shows CSG, RAN, Customer groups; MW absent", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-UPE1",
      max_depth: 10,
      include_transport: false,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();

    // Groups keyed by level — expect levels 3 (CSG×1), 4 (RAN×3 — reached via
    // both MW1 and MW2 as transit), 5 (Customer×15). MW is absent.
    const byLevel = new Map(r.groups.map((g) => [g.level, g]));
    expect(byLevel.get(3)?.count).toBe(1);
    expect(byLevel.get(4)?.count).toBe(3);
    expect(byLevel.get(5)?.count).toBe(15);
    expect(byLevel.get(3.5)).toBeUndefined();
    expect(r.total).toBe(19);
  });

  it("include_transport=true: MW group appears; total includes MW hops", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-UPE1",
      max_depth: 10,
      include_transport: true,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    const byLevel = new Map(r.groups.map((g) => [g.level, g]));
    expect(byLevel.get(3.5)?.count).toBe(2);
    // 1 CSG + 2 MW + 3 RAN + 15 Customer = 21
    expect(r.total).toBe(21);
  });

  it("CSG2 does NOT include CSG3 (same-level peer is not downstream)", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-CSG2",
      max_depth: 10,
      include_transport: false,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    const names = r.groups.flatMap((g) => g.devices.map((d) => d.name));
    expect(names).not.toContain("A4-CSG3");
    expect(r.total).toBe(0);
  });

  it("island device returns ok with total=0 and no groups", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-ISLAND",
      max_depth: 10,
      include_transport: false,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    expect(r.total).toBe(0);
    expect(r.groups).toEqual([]);
  });

  it("unknown device returns status=start_not_found", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "GHOST-A4-NO-SUCH",
      max_depth: 10,
      include_transport: false,
    });
    expect(r.status).toBe("start_not_found");
  });

  it("max_depth=1 from UPE1: only direct neighbour CSG1 (1 hop away)", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-UPE1",
      max_depth: 1,
      include_transport: false,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    expect(r.total).toBe(1);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.level).toBe(3);
    expect(r.groups[0]!.devices[0]!.name).toBe("A4-CSG1");
  });

  it("cycle/peer safety: UPE2 downstream does not duplicate CSG2 or CSG3", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-UPE2",
      max_depth: 10,
      include_transport: false,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    const names = r.groups.flatMap((g) => g.devices.map((d) => d.name));
    // CSG2 and CSG3 each appear exactly once despite the peer edge between them
    // (which could otherwise produce duplicate walks).
    expect(names.filter((n) => n === "A4-CSG2")).toHaveLength(1);
    expect(names.filter((n) => n === "A4-CSG3")).toHaveLength(1);
    expect(names).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it("CORE1 downstream covers full subtree (all non-MW devices minus CORE itself and ISLAND)", async () => {
    const { runDownstream } = await import("@/lib/downstream");
    const r = await runDownstream({
      device: "A4-CORE1",
      max_depth: 10,
      include_transport: false,
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    // 2 UPE + 3 CSG + 3 RAN + 15 Customer = 23 (MW filtered out)
    expect(r.total).toBe(23);
    // group counts sum to total
    const sum = r.groups.reduce((s, g) => s + g.count, 0);
    expect(sum).toBe(r.total);
  });
});

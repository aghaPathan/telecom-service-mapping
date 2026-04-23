import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for device-detail lib against a real Neo4j 5 container.
// Mirrors the pattern in apps/web/test/path.int.test.ts — set NEO4J_* env
// vars before dynamically importing the lib so the cached getDriver()
// singleton picks them up.

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
      "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.cid IS UNIQUE",
    );
    await session.run(
      "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
    );

    // Core devices + one island + pagination target.
    //
    // ICSG-1's immediate neighbors: UPE-1 (level 2), RAN-1 (level 4), RAN-2 (level 4).
    // The ICSG-1 -> UPE-1 edge is stored forward (ICSG-1 is startNode),
    // so local_if = a_if, remote_if = b_if when subject is ICSG-1.
    // The RAN-1 -> ICSG-1 edge is stored reversed (RAN-1 is startNode),
    // so for ICSG-1 as subject, local_if must come from b_if, remote_if from a_if.
    // RAN-2 -> ICSG-1 also reversed (RAN-2 as startNode). Also gives status=true on
    // the UPE-1 edge to assert status passthrough; others omit status → null.
    await session.run(
      `CREATE
        (icsg1:Device:ICSG {name:'ICSG-1', role:'CSG', level:3, site:'JED', vendor:'Huawei', domain:'D'}),
        (icsg2:Device:ICSG {name:'ICSG-2', role:'CSG', level:3, site:'JED', vendor:'Huawei', domain:'D'}),
        (upe1:Device:UPE   {name:'UPE-1',  role:'UPE', level:2, site:'JED', vendor:'Huawei', domain:'D'}),
        (ran1:Device:RAN   {name:'RAN-1',  role:'Ran', level:4, site:'JED', vendor:'Huawei', domain:'D'}),
        (ran2:Device:RAN   {name:'RAN-2',  role:'Ran', level:4, site:'JED', vendor:'Huawei', domain:'D'}),
        (island:Device:ICSG {name:'ISLAND-1', role:'CSG', level:3, site:'JED', vendor:'Huawei', domain:'D'}),
        (icsg1)-[:CONNECTS_TO {a_if:'icsg1-to-upe1', b_if:'upe1-to-icsg1', status:true}]->(upe1),
        (ran1)-[:CONNECTS_TO {a_if:'ran1-to-icsg1', b_if:'icsg1-to-ran1'}]->(icsg1),
        (ran2)-[:CONNECTS_TO {a_if:'ran2-to-icsg1', b_if:'icsg1-to-ran2'}]->(icsg1),
        (svc:Service {cid:'S1', mobily_cid:'M1'})-[:TERMINATES_AT {role:'source'}]->(icsg1)
      `,
    );

    // 60 RAN neighbors for ICSG-2 to exercise pagination.
    await session.run(
      `UNWIND range(1, 60) AS i
       WITH i, CASE
         WHEN i < 10  THEN 'NB-00' + toString(i)
         WHEN i < 100 THEN 'NB-0'  + toString(i)
         ELSE              'NB-'   + toString(i)
       END AS nbName
       MATCH (icsg2:Device {name:'ICSG-2'})
       CREATE (nb:Device:RAN {name: nbName, role:'Ran', level:4, site:'JED', vendor:'Huawei', domain:'D'})
       CREATE (icsg2)-[:CONNECTS_TO {a_if:'icsg2-to-' + nbName, b_if:nbName + '-to-icsg2'}]->(nb)`,
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

describe("device-detail lib against live Neo4j", () => {
  it("loadDevice returns device projection", async () => {
    const { loadDevice } = await import("@/lib/device-detail");
    const d = await loadDevice("ICSG-1");
    expect(d).toEqual({
      name: "ICSG-1",
      role: "CSG",
      level: 3,
      site: "JED",
      vendor: "Huawei",
      domain: "D",
    });
  });

  it("loadDevice returns null for unknown device", async () => {
    const { loadDevice } = await import("@/lib/device-detail");
    const d = await loadDevice("NO-SUCH-DEVICE");
    expect(d).toBeNull();
  });

  it("loadNeighbors ICSG-1 sorted by role", async () => {
    const { loadNeighbors } = await import("@/lib/device-detail");
    const r = await loadNeighbors("ICSG-1", { page: 0, size: 50, sortBy: "role" });
    expect(r.total).toBe(3);
    expect(r.rows).toHaveLength(3);
    // role ASC (Ran, Ran, UPE); tie-broken by name ASC (RAN-1, RAN-2).
    expect(r.rows.map((n) => n.name)).toEqual(["RAN-1", "RAN-2", "UPE-1"]);

    // Interface picker coverage: UPE-1 edge is stored forward from ICSG-1,
    // so on ICSG-1's side, local_if = a_if = 'icsg1-to-upe1'.
    const upe = r.rows.find((n) => n.name === "UPE-1")!;
    expect(upe.local_if).toBe("icsg1-to-upe1");
    expect(upe.remote_if).toBe("upe1-to-icsg1");
    expect(upe.status).toBe(true);

    // RAN-1 edge is stored reversed (RAN-1 is startNode), so on ICSG-1's
    // side, local_if = b_if = 'icsg1-to-ran1'.
    const ran1 = r.rows.find((n) => n.name === "RAN-1")!;
    expect(ran1.local_if).toBe("icsg1-to-ran1");
    expect(ran1.remote_if).toBe("ran1-to-icsg1");
    expect(ran1.status).toBeNull();
  });

  it("loadNeighbors ICSG-1 sorted by level", async () => {
    const { loadNeighbors } = await import("@/lib/device-detail");
    const r = await loadNeighbors("ICSG-1", { page: 0, size: 50, sortBy: "level" });
    expect(r.total).toBe(3);
    expect(r.rows.map((n) => n.name)).toEqual(["UPE-1", "RAN-1", "RAN-2"]);
  });

  it("loadNeighbors ICSG-2 page 0 returns first 50", async () => {
    const { loadNeighbors } = await import("@/lib/device-detail");
    const r = await loadNeighbors("ICSG-2", { page: 0, size: 50, sortBy: "role" });
    expect(r.total).toBe(60);
    expect(r.rows).toHaveLength(50);
  });

  it("loadNeighbors ICSG-2 page 1 returns remaining 10", async () => {
    const { loadNeighbors } = await import("@/lib/device-detail");
    const r = await loadNeighbors("ICSG-2", { page: 1, size: 50, sortBy: "role" });
    expect(r.total).toBe(60);
    expect(r.rows).toHaveLength(10);
  });

  it("loadNeighbors island returns empty", async () => {
    const { loadNeighbors } = await import("@/lib/device-detail");
    const r = await loadNeighbors("ISLAND-1", { page: 0, size: 50, sortBy: "role" });
    expect(r).toEqual({ rows: [], total: 0 });
  });

  it("loadCircuits returns terminating services", async () => {
    const { loadCircuits } = await import("@/lib/device-detail");
    const r = await loadCircuits("ICSG-1");
    expect(r).toEqual([{ cid: "S1", mobily_cid: "M1", role: "source" }]);
  });

  it("loadCircuits returns empty for unknown device", async () => {
    const { loadCircuits } = await import("@/lib/device-detail");
    const r = await loadCircuits("NO-SUCH-DEVICE");
    expect(r).toEqual([]);
  });
});

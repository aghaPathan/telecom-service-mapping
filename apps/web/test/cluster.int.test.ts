import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for runCluster against a real Neo4j 5 container.
// Mirrors apps/web/test/path.int.test.ts — NEO4J_* env vars set before
// dynamically importing the resolver so getDriver()'s singleton picks them up.

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

    // Site BIG: 5 UPEs (above CLUSTER_THRESHOLD=3) + 1 core + 2 CSGs + 1 MW.
    // Site SMALL: 2 UPEs (at/below threshold) + 1 CSG.
    // Site EMPTY: no devices (exists as a query target to verify empty shape).
    await session.run(`
      CREATE
        (:Device:CORE {name:'BIG-CORE-01', role:'CORE', level:1, site:'BIG', vendor:'cisco'}),
        (:Device:UPE  {name:'BIG-UPE-01',  role:'UPE',  level:2, site:'BIG', vendor:'cisco'}),
        (:Device:UPE  {name:'BIG-UPE-02',  role:'UPE',  level:2, site:'BIG', vendor:'cisco'}),
        (:Device:UPE  {name:'BIG-UPE-03',  role:'UPE',  level:2, site:'BIG', vendor:'huawei'}),
        (:Device:UPE  {name:'BIG-UPE-04',  role:'UPE',  level:2, site:'BIG', vendor:'huawei'}),
        (:Device:UPE  {name:'BIG-UPE-05',  role:'UPE',  level:2, site:'BIG', vendor:'huawei'}),
        (:Device:CSG  {name:'BIG-CSG-01',  role:'CSG',  level:3, site:'BIG', vendor:'cisco'}),
        (:Device:CSG  {name:'BIG-CSG-02',  role:'CSG',  level:3, site:'BIG', vendor:'cisco'}),
        (:Device:MW   {name:'BIG-MW-01',   role:'MW',   level:3.5, site:'BIG', vendor:null}),
        (:Device:UPE  {name:'SMALL-UPE-01', role:'UPE', level:2, site:'SMALL', vendor:'cisco'}),
        (:Device:UPE  {name:'SMALL-UPE-02', role:'UPE', level:2, site:'SMALL', vendor:'cisco'}),
        (:Device:CSG  {name:'SMALL-CSG-01', role:'CSG', level:3, site:'SMALL', vendor:'cisco'})
    `);
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

describe("runCluster against live Neo4j", () => {
  it("BIG (5 UPEs, auto): clusters UPEs and leaves them out of the flat list", async () => {
    const { runCluster } = await import("@/lib/cluster");
    const r = await runCluster({ site: "BIG" });

    expect(r.site).toBe("BIG");
    expect(r.core.map((d) => d.name)).toEqual(["BIG-CORE-01"]);
    expect(r.csgs.map((d) => d.name).sort()).toEqual([
      "BIG-CSG-01",
      "BIG-CSG-02",
    ]);
    expect(r.transport.map((d) => d.name)).toEqual(["BIG-MW-01"]);

    expect(r.upeCluster).not.toBeNull();
    expect(r.upeCluster!.site).toBe("BIG");
    expect(r.upeCluster!.count).toBe(5);
    expect(r.upeCluster!.nodes.map((d) => d.name).sort()).toEqual([
      "BIG-UPE-01",
      "BIG-UPE-02",
      "BIG-UPE-03",
      "BIG-UPE-04",
      "BIG-UPE-05",
    ]);
    expect(r.upes).toEqual([]); // clustered ⇒ flat list is empty
  });

  it("BIG with clusterUpes=false: inverts to flat UPE list, no cluster", async () => {
    const { runCluster } = await import("@/lib/cluster");
    const r = await runCluster({ site: "BIG", clusterUpes: false });
    expect(r.upeCluster).toBeNull();
    expect(r.upes.map((d) => d.name).sort()).toEqual([
      "BIG-UPE-01",
      "BIG-UPE-02",
      "BIG-UPE-03",
      "BIG-UPE-04",
      "BIG-UPE-05",
    ]);
  });

  it("SMALL (2 UPEs, auto): does NOT cluster — flat list, upeCluster null", async () => {
    const { runCluster } = await import("@/lib/cluster");
    const r = await runCluster({ site: "SMALL" });
    expect(r.upeCluster).toBeNull();
    expect(r.upes.map((d) => d.name).sort()).toEqual([
      "SMALL-UPE-01",
      "SMALL-UPE-02",
    ]);
    expect(r.csgs.map((d) => d.name)).toEqual(["SMALL-CSG-01"]);
    expect(r.core).toEqual([]);
    expect(r.transport).toEqual([]);
  });

  it("SMALL with clusterUpes=true: force-clusters even below threshold", async () => {
    const { runCluster } = await import("@/lib/cluster");
    const r = await runCluster({ site: "SMALL", clusterUpes: true });
    expect(r.upeCluster?.count).toBe(2);
    expect(r.upes).toEqual([]);
  });

  it("unknown site returns empty shape (not an error)", async () => {
    const { runCluster } = await import("@/lib/cluster");
    const r = await runCluster({ site: "DOES-NOT-EXIST" });
    expect(r).toEqual({
      site: "DOES-NOT-EXIST",
      core: [],
      upes: [],
      upeCluster: null,
      csgs: [],
      transport: [],
    });
  });

  it("preserves vendor field including null", async () => {
    const { runCluster } = await import("@/lib/cluster");
    const r = await runCluster({ site: "BIG" });
    expect(r.transport[0]!.vendor).toBeNull();
    expect(r.core[0]!.vendor).toBe("cisco");
  });
});

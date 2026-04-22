import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test against a real Neo4j 5 container. The runSearch function
// imports getDriver() from @/lib/neo4j which honors NEO4J_* env vars; we
// set those before the dynamic import so the singleton picks them up.

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

async function seed(driver: Driver) {
  const session = driver.session();
  try {
    // Mirrors constraints + fulltext index from apps/ingestor/src/graph/writer.ts
    await session.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    await session.run(
      "CREATE CONSTRAINT service_cid_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.cid IS UNIQUE",
    );
    await session.run(
      "CREATE INDEX service_mobily_cid IF NOT EXISTS FOR (s:Service) ON (s.mobily_cid)",
    );
    await session.run(
      "CREATE FULLTEXT INDEX device_name_fulltext IF NOT EXISTS FOR (d:Device) ON EACH [d.name]",
    );

    // Devices: 3 with similar names to test fulltext ranking
    await session.run(
      `CREATE (:Device:Core {name: 'PK-KHI-CORE-01', role: 'Core', level: 1, site: 'KHI', domain: 'Mpls'}),
              (:Device:UPE  {name: 'PK-KHI-UPE-01',  role: 'UPE',  level: 2, site: 'KHI', domain: 'Mpls'}),
              (:Device:CSG  {name: 'PK-LHE-CSG-01',  role: 'CSG',  level: 3, site: 'LHE', domain: 'Mpls'})`,
    );

    // A service whose cid shadows a device name — proves cascade precedence.
    await session.run(
      `CREATE (s:Service {cid: 'PK-KHI-CORE-01', mobily_cid: 'M-9999',
                          bandwidth: '10G', protection_type: '1+1', region: 'North'})`,
    );
    // A second service with a clean mobily_cid, no cid collision
    await session.run(
      `CREATE (:Service {cid: 'C-BIZ-001', mobily_cid: 'MOB-BIZ-42',
                         bandwidth: '1G', protection_type: 'unprotected', region: 'Central'})`,
    );
    // Wire TERMINATES_AT for the service whose cid matches first test
    await session.run(
      `MATCH (s:Service {cid: 'PK-KHI-CORE-01'}), (d:Device {name: 'PK-KHI-UPE-01'})
       CREATE (s)-[:TERMINATES_AT {role: 'source'}]->(d)`,
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
  // Force-close the cached driver used by runSearch
  const { getDriver } = await import("@/lib/neo4j");
  try {
    await getDriver().close();
  } catch {
    /* already closed */
  }
  await neo4jC?.stop();
}, 60_000);

describe("runSearch against live Neo4j", () => {
  it("exact cid shadows a device name of the same string", async () => {
    const { runSearch } = await import("@/lib/search");
    const r = await runSearch("PK-KHI-CORE-01");
    // Even though a Device named 'PK-KHI-CORE-01' exists, cid wins.
    expect(r.kind).toBe("service");
    if (r.kind !== "service") throw new Error();
    expect(r.service.cid).toBe("PK-KHI-CORE-01");
    expect(r.endpoints.map((e) => e.name)).toContain("PK-KHI-UPE-01");
  });

  it("exact mobily_cid hit", async () => {
    const { runSearch } = await import("@/lib/search");
    const r = await runSearch("MOB-BIZ-42");
    expect(r.kind).toBe("service");
    if (r.kind !== "service") throw new Error();
    expect(r.service.cid).toBe("C-BIZ-001");
  });

  it("exact device name when no service matches", async () => {
    const { runSearch } = await import("@/lib/search");
    const r = await runSearch("PK-KHI-UPE-01");
    expect(r.kind).toBe("device");
    if (r.kind !== "device") throw new Error();
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]!.name).toBe("PK-KHI-UPE-01");
    expect(r.devices[0]!.role).toBe("UPE");
  });

  it("fulltext prefix match returns ranked results", async () => {
    const { runSearch } = await import("@/lib/search");
    const r = await runSearch("PK-KHI");
    expect(r.kind).toBe("device");
    if (r.kind !== "device") throw new Error();
    const names = r.devices.map((d) => d.name);
    expect(names).toContain("PK-KHI-CORE-01");
    expect(names).toContain("PK-KHI-UPE-01");
    expect(names).not.toContain("PK-LHE-CSG-01");
  });

  it("injection-looking query with Lucene specials returns empty, never throws", async () => {
    const { runSearch } = await import("@/lib/search");
    const r = await runSearch("foo:bar AND (1=1)");
    expect(r.kind).toBe("device");
    if (r.kind !== "device") throw new Error();
    expect(r.devices).toHaveLength(0);
  });

  it("no match returns empty device list", async () => {
    const { runSearch } = await import("@/lib/search");
    const r = await runSearch("ZZZ-NO-SUCH-DEVICE-9999");
    expect(r.kind).toBe("device");
    if (r.kind !== "device") throw new Error();
    expect(r.devices).toHaveLength(0);
  });
});

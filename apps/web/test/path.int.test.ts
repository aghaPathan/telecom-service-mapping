import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for runPath against a real Neo4j 5 container. Mirrors the
// pattern in apps/web/test/search.int.test.ts — we set NEO4J_* env vars
// before dynamically importing the resolver so the cached getDriver()
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

    // Linear chain: Customer(5) -> CSG(3) -> UPE(2) -> Core1(1)
    // Plus an Island CSG(3) with no edges so it cannot reach any Core.
    await session.run(
      `CREATE
        (cust:Device:CUSTOMER {name:'Customer', role:'Customer', level:5, site:'S', domain:'D'}),
        (csg:Device:CSG       {name:'CSG',      role:'CSG',      level:3, site:'S', domain:'D'}),
        (upe:Device:UPE       {name:'UPE',      role:'UPE',      level:2, site:'S', domain:'D'}),
        (core:Device:CORE     {name:'Core1',    role:'CORE',     level:1, site:'S', domain:'D'}),
        (island:Device:CSG    {name:'Island',   role:'CSG',      level:3, site:'I', domain:'D'}),
        (cust)-[:CONNECTS_TO {a_if:'c-to-csg',   b_if:'csg-to-c'}]->(csg),
        (csg)-[:CONNECTS_TO  {a_if:'csg-to-upe', b_if:'upe-to-csg'}]->(upe),
        (upe)-[:CONNECTS_TO  {a_if:'upe-to-core', b_if:'core-to-upe'}]->(core),
        (svc:Service {cid:'C1', mobily_cid:'M1'})-[:TERMINATES_AT {role:'source'}]->(csg)
      `,
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

describe("runPath against live Neo4j", () => {
  it("device start traces to the core", async () => {
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: "Customer" });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    expect(r.hops.map((h) => h.name)).toEqual(["Customer", "CSG", "UPE", "Core1"]);
    expect(r.length).toBe(3);
  });

  it("service start resolves to source endpoint and traces to the core", async () => {
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "service", value: "C1" });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    expect(r.hops[0]!.name).toBe("CSG");
    expect(r.hops[r.hops.length - 1]!.name).toBe("Core1");
  });

  it("island device returns no_path with reason island", async () => {
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: "Island" });
    expect(r.status).toBe("no_path");
    if (r.status !== "no_path") throw new Error();
    expect(r.reason).toBe("island");
    expect(r.unreached_at?.name).toBe("Island");
    expect(r.unreached_at?.site).toBe("I");
    expect(r.unreached_at?.domain).toBe("D");
  });

  it("unknown device returns no_path with reason start_not_found", async () => {
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: "GHOST-NO-SUCH" });
    expect(r.status).toBe("no_path");
    if (r.status !== "no_path") throw new Error();
    expect(r.reason).toBe("start_not_found");
    expect(r.unreached_at).toBeNull();
  });

  it("unknown service returns no_path with reason service_has_no_endpoint", async () => {
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "service", value: "NO-SUCH-CID" });
    expect(r.status).toBe("no_path");
    if (r.status !== "no_path") throw new Error();
    expect(r.reason).toBe("service_has_no_endpoint");
  });

  it("interface sanity: middle hop has both in_if and out_if, edges on ends are null", async () => {
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: "Customer" });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error();
    expect(r.hops[1]!.in_if).not.toBeNull();
    expect(r.hops[1]!.out_if).not.toBeNull();
    expect(r.hops[0]!.in_if).toBeNull();
    expect(r.hops[r.hops.length - 1]!.out_if).toBeNull();
  });
});

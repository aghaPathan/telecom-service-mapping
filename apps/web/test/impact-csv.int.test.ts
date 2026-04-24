import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";
import { NextRequest } from "next/server";

// Integration test for /api/impact/csv against a real Neo4j 5 container.
// Mirrors impact.int.test.ts' I5- fixture (seed duplicated intentionally — same
// style as downstream.int.test.ts). Adds a hostile `=CMD|evil` device to
// exercise the formula-injection guard in csvRow.

vi.mock("@/lib/rbac", () => ({
  requireRole: async () => ({ user: { id: "t", role: "viewer" } }),
}));
vi.mock("@/lib/rate-limit", () => ({
  tryConsume: () => ({ ok: true }),
}));

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

    // Hostile device — formula-injection smoke. Placed under I5-RAN1 at
    // level=5 so it appears in the I5-UPE1 CSV subtree (traversal must be
    // strictly level-increasing).
    await session.run(
      `MERGE (h:Device {name:'=CMD|evil'})
       SET h.role='Customer', h.level=5, h.site='S', h.domain='D', h.vendor='CPE'
       WITH h
       MATCH (ran1:Device {name:'I5-RAN1'})
       MERGE (ran1)-[:CONNECTS_TO]->(h)`,
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

describe("/api/impact/csv", () => {
  it("exports CSV with name,role,level,site,vendor,hops header", async () => {
    const { GET } = await import("@/app/api/impact/csv/route");
    const req = new NextRequest(
      "http://test.local/api/impact/csv?device=I5-UPE1&include_transport=false&max_depth=10",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    const [header, ...dataLines] = body.trim().split("\n");
    expect(header).toBe("name,role,level,site,vendor,hops");
    expect(dataLines.some((l) => l.startsWith("I5-CSG1,"))).toBe(true);
  });

  it("escapes formula-injection attempts in device names", async () => {
    const { GET } = await import("@/app/api/impact/csv/route");
    const req = new NextRequest(
      "http://test.local/api/impact/csv?device=I5-UPE1&include_transport=false&max_depth=10",
    );
    const res = await GET(req);
    const body = await res.text();
    // formula-guarded cell: leading `=` prefixed with apostrophe + wrapped in quotes
    expect(body).toContain(`"'=CMD|evil"`);
  });

  it("returns 404 start_not_found for unknown device", async () => {
    const { GET } = await import("@/app/api/impact/csv/route");
    const req = new NextRequest(
      "http://test.local/api/impact/csv?device=I5-NOPE",
    );
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});

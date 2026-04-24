import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";
import { NextRequest } from "next/server";

// Integration test for /api/devices/list/csv against a real Neo4j 5 container.
// Seeds a small GPON fixture with a formula-injection smoke device.

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
    // GPON devices — one with leading `=` to exercise formula-injection guard.
    await session.run(
      `MERGE (a:Device {name:'G1-GPON1'}) SET a.role='GPON', a.level=3, a.site='S-A', a.vendor='Huawei'
       MERGE (b:Device {name:'G1-GPON2'}) SET b.role='GPON', b.level=3, b.site='S-B', b.vendor='Nokia'
       MERGE (c:Device {name:'G1-GPON3'}) SET c.role='GPON', c.level=3, c.site='S-C', c.vendor='Huawei'
       MERGE (h:Device {name:'=DANGEROUS'}) SET h.role='GPON', h.level=3, h.site='S-A', h.vendor='Huawei'
       MERGE (core:Device {name:'G1-CORE1'}) SET core.role='CORE', core.level=1, core.site='S-A', core.vendor='Cisco'
       MERGE (core)-[:CONNECTS_TO]->(a)
       MERGE (core)-[:CONNECTS_TO]->(b)`,
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

describe("/api/devices/list/csv", () => {
  it("byRole=GPON exports CSV with expected header + rows + filename", async () => {
    const { GET } = await import("@/app/api/devices/list/csv/route");
    const req = new NextRequest(
      "http://test.local/api/devices/list/csv?mode=byRole&role=GPON",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("devices-byRole-GPON.csv");

    const body = await res.text();
    const [header, ...dataLines] = body.trim().split("\n");
    expect(header).toBe("name,role,level,site,vendor");
    // Seeded GPON device names appear (sorted asc by default).
    expect(dataLines.some((l) => l.startsWith("G1-GPON1,"))).toBe(true);
    expect(dataLines.some((l) => l.startsWith("G1-GPON2,"))).toBe(true);
    expect(dataLines.some((l) => l.startsWith("G1-GPON3,"))).toBe(true);
  });

  it("byRole with unknown role returns 400", async () => {
    const { GET } = await import("@/app/api/devices/list/csv/route");
    const req = new NextRequest(
      "http://test.local/api/devices/list/csv?mode=byRole&role=Nonsense",
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("guards formula-injection in device names", async () => {
    const { GET } = await import("@/app/api/devices/list/csv/route");
    const req = new NextRequest(
      "http://test.local/api/devices/list/csv?mode=byRole&role=GPON",
    );
    const res = await GET(req);
    const body = await res.text();
    // csvEscape wraps formula-guarded cells in quotes and prefixes `'`.
    // Assert the cell starts with `"'=` — never a bare `=` at start of a cell.
    expect(body).toContain(`"'=DANGEROUS"`);
    // And no unguarded line starting with `=DANGEROUS,`.
    for (const line of body.split("\n")) {
      expect(line.startsWith("=DANGEROUS")).toBe(false);
    }
  });

  it("byFanout&limit=5 returns 200 with fanout column", async () => {
    const { GET } = await import("@/app/api/devices/list/csv/route");
    const req = new NextRequest(
      "http://test.local/api/devices/list/csv?mode=byFanout&limit=5",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body.trim().split("\n");
    const [header, ...rows] = lines;
    expect(header).toBe("name,role,level,site,vendor,fanout");

    // Cross-check the row count matches runDeviceList for the same query.
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "byFanout", limit: 5 });
    const r = await runDeviceList(q);
    expect(rows.length).toBe(r.rows.length);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("byLevel=1 returns 200", async () => {
    const { GET } = await import("@/app/api/devices/list/csv/route");
    const req = new NextRequest(
      "http://test.local/api/devices/list/csv?mode=byLevel&level=1",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    const [header, ...dataLines] = body.trim().split("\n");
    expect(header).toBe("name,role,level,site,vendor");
    expect(dataLines.some((l) => l.startsWith("G1-CORE1,"))).toBe(true);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("devices-byLevel-level-1.csv");
  });
});

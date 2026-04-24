import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for runDeviceList against a real Neo4j 5 container.
// Fixture nodes are prefixed `B3-` so this suite is namespace-isolated.

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

type Dev = {
  name: string;
  role: string;
  level: number;
  site: string;
  vendor: string;
};

const DEVICES: Dev[] = [
  // CORE x2 (level 1)
  { name: "B3-CORE1", role: "CORE", level: 1, site: "S-A", vendor: "Huawei" },
  { name: "B3-CORE2", role: "CORE", level: 1, site: "S-B", vendor: "Nokia" },
  // UPE x4 (level 2)
  { name: "B3-UPE1", role: "UPE", level: 2, site: "S-A", vendor: "Huawei" },
  { name: "B3-UPE2", role: "UPE", level: 2, site: "S-B", vendor: "Nokia" },
  { name: "B3-UPE3", role: "UPE", level: 2, site: "S-C", vendor: "Huawei" },
  { name: "B3-UPE4", role: "UPE", level: 2, site: "S-A", vendor: "Cisco" },
  // SW x2 (level 2)
  { name: "B3-SW1", role: "SW", level: 2, site: "S-A", vendor: "Cisco" },
  { name: "B3-SW2", role: "SW", level: 2, site: "S-B", vendor: "Cisco" },
  // GPON x8 (level 3) — sites varied to exercise sort=site desc
  { name: "B3-GPON1", role: "GPON", level: 3, site: "S-A", vendor: "Huawei" },
  { name: "B3-GPON2", role: "GPON", level: 3, site: "S-A", vendor: "Huawei" },
  { name: "B3-GPON3", role: "GPON", level: 3, site: "S-B", vendor: "Nokia" },
  { name: "B3-GPON4", role: "GPON", level: 3, site: "S-B", vendor: "Nokia" },
  { name: "B3-GPON5", role: "GPON", level: 3, site: "S-C", vendor: "Huawei" },
  { name: "B3-GPON6", role: "GPON", level: 3, site: "S-C", vendor: "Huawei" },
  { name: "B3-GPON7", role: "GPON", level: 3, site: "S-D", vendor: "Nokia" },
  { name: "B3-GPON8", role: "GPON", level: 3, site: "S-D", vendor: "Nokia" },
  // CSG x3 (level 3)
  { name: "B3-CSG1", role: "CSG", level: 3, site: "S-A", vendor: "Huawei" },
  { name: "B3-CSG2", role: "CSG", level: 3, site: "S-B", vendor: "Nokia" },
  { name: "B3-CSG3", role: "CSG", level: 3, site: "S-C", vendor: "Huawei" },
  // MW x3 (level 3.5)
  { name: "B3-MW1", role: "MW", level: 3.5, site: "S-A", vendor: "Ericsson" },
  { name: "B3-MW2", role: "MW", level: 3.5, site: "S-B", vendor: "Ericsson" },
  { name: "B3-MW3", role: "MW", level: 3.5, site: "S-C", vendor: "Ericsson" },
  // RAN x5 (level 4) — design high fanout for RAN1
  { name: "B3-RAN1", role: "RAN", level: 4, site: "S-A", vendor: "Huawei" },
  { name: "B3-RAN2", role: "RAN", level: 4, site: "S-A", vendor: "Huawei" },
  { name: "B3-RAN3", role: "RAN", level: 4, site: "S-B", vendor: "Nokia" },
  { name: "B3-RAN4", role: "RAN", level: 4, site: "S-C", vendor: "Nokia" },
  { name: "B3-RAN5", role: "RAN", level: 4, site: "S-D", vendor: "Huawei" },
];

// Edges — give CORE1 very high fanout (hub), then CORE2, then a RAN hub.
// Fanout is undirected count of CONNECTS_TO edges.
const EDGES: Array<[string, string]> = [
  // CORE1 -> all UPEs + both SWs + CORE2 (fanout = 7)
  ["B3-CORE1", "B3-UPE1"],
  ["B3-CORE1", "B3-UPE2"],
  ["B3-CORE1", "B3-UPE3"],
  ["B3-CORE1", "B3-UPE4"],
  ["B3-CORE1", "B3-SW1"],
  ["B3-CORE1", "B3-SW2"],
  ["B3-CORE1", "B3-CORE2"],
  // CORE2 -> UPE1, UPE2 (fanout += 2; total CORE2 = 3 with the CORE1-CORE2 edge)
  ["B3-CORE2", "B3-UPE1"],
  ["B3-CORE2", "B3-UPE2"],
  // RAN1 hub: connects to 4 GPONs (fanout = 4)
  ["B3-RAN1", "B3-GPON1"],
  ["B3-RAN1", "B3-GPON2"],
  ["B3-RAN1", "B3-GPON3"],
  ["B3-RAN1", "B3-GPON4"],
  // RAN2: connects to 2 GPONs
  ["B3-RAN2", "B3-GPON5"],
  ["B3-RAN2", "B3-GPON6"],
  // RAN3: 1 edge
  ["B3-RAN3", "B3-GPON7"],
  // MW1 -> RAN1, RAN2
  ["B3-MW1", "B3-RAN1"],
  ["B3-MW1", "B3-RAN2"],
  // MW2 -> RAN3
  ["B3-MW2", "B3-RAN3"],
  // CSG1 -> MW1
  ["B3-CSG1", "B3-MW1"],
];

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
      `UNWIND $devices AS row
       MERGE (d:Device {name: row.name})
       SET d.role = row.role, d.level = row.level, d.site = row.site, d.vendor = row.vendor`,
      { devices: DEVICES },
    );
    await session.run(
      `UNWIND $edges AS e
       MATCH (a:Device {name: e[0]})
       MATCH (b:Device {name: e[1]})
       MERGE (a)-[:CONNECTS_TO]->(b)`,
      { edges: EDGES },
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

describe("runDeviceList against live Neo4j", () => {
  it("byRole=GPON returns only GPON devices", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({
      mode: "byRole",
      role: "GPON",
      pageSize: 100,
    });
    const r = await runDeviceList(q);
    expect(r.total).toBe(8);
    expect(r.rows).toHaveLength(8);
    for (const row of r.rows) expect(row.role).toBe("GPON");
  });

  it("byRole=GPON with page=2 pageSize=5 returns rows 6-8 (slice of 3)", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({
      mode: "byRole",
      role: "GPON",
      page: 2,
      pageSize: 5,
    });
    const r = await runDeviceList(q);
    expect(r.total).toBe(8);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(5);
    expect(r.rows).toHaveLength(3);
    // Sorted by name asc — so page 2 contains GPON6, GPON7, GPON8
    expect(r.rows.map((x) => x.name)).toEqual([
      "B3-GPON6",
      "B3-GPON7",
      "B3-GPON8",
    ]);
  });

  it("byRole honors sort=site dir=desc", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({
      mode: "byRole",
      role: "GPON",
      sort: "site",
      dir: "desc",
      pageSize: 100,
    });
    const r = await runDeviceList(q);
    // Sites: S-A (2), S-B (2), S-C (2), S-D (2). desc -> S-D first.
    const firstTwoSites = r.rows.slice(0, 2).map((x) => x.site);
    expect(firstTwoSites).toEqual(["S-D", "S-D"]);
    const lastTwoSites = r.rows.slice(-2).map((x) => x.site);
    expect(lastTwoSites).toEqual(["S-A", "S-A"]);
  });

  it("byLevel=1 returns only level-1 devices", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "byLevel", level: 1 });
    const r = await runDeviceList(q);
    expect(r.total).toBe(2);
    for (const row of r.rows) expect(row.level).toBe(1);
    expect(r.rows.map((x) => x.name).sort()).toEqual([
      "B3-CORE1",
      "B3-CORE2",
    ]);
  });

  it("byLevel=3.5 returns only MW devices (float comparison)", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "byLevel", level: 3.5 });
    const r = await runDeviceList(q);
    expect(r.total).toBe(3);
    for (const row of r.rows) {
      expect(row.level).toBe(3.5);
      expect(row.role).toBe("MW");
    }
  });

  it("byFanout limit=3 returns 3 highest-fanout devices desc", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "byFanout", limit: 3 });
    const r = await runDeviceList(q);
    expect(r.rows).toHaveLength(3);
    // CORE1 has 7, then RAN1 has 4 (incl. MW1 edge and 4 GPON + 1 MW = 5 actually)
    // Let's just assert the structure + ordering.
    expect(r.rows[0]!.name).toBe("B3-CORE1");
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i - 1]!.fanout!).toBeGreaterThanOrEqual(
        r.rows[i]!.fanout!,
      );
    }
    for (const row of r.rows) {
      expect(typeof row.fanout).toBe("number");
    }
  });

  it("byFanout role=RAN limit=2 returns top-2 RAN devices by fanout", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({
      mode: "byFanout",
      role: "RAN",
      limit: 2,
    });
    const r = await runDeviceList(q);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.role).toBe("RAN");
    // RAN1 has the most edges (4 GPONs + 1 MW = 5) -> first
    expect(r.rows[0]!.name).toBe("B3-RAN1");
    expect(r.rows[0]!.fanout!).toBeGreaterThanOrEqual(r.rows[1]!.fanout!);
  });

  it("bySite=S-A returns only devices from site S-A", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "bySite", site: "S-A", pageSize: 100 });
    const r = await runDeviceList(q);
    // S-A devices: CORE1, UPE1, UPE4, SW1, GPON1, GPON2, CSG1, MW1, RAN1, RAN2 = 10
    expect(r.total).toBe(10);
    expect(r.rows).toHaveLength(10);
    for (const row of r.rows) expect(row.site).toBe("S-A");
  });

  it("bySite=S-D returns only devices from site S-D", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "bySite", site: "S-D", pageSize: 100 });
    const r = await runDeviceList(q);
    // S-D devices: GPON7, GPON8, RAN5 = 3
    expect(r.total).toBe(3);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) expect(row.site).toBe("S-D");
  });

  it("bySite with a site that has no devices returns 0 rows", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const q = parseDeviceListQuery({ mode: "bySite", site: "NONEXISTENT" });
    const r = await runDeviceList(q);
    expect(r.total).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it("bySite pagination: total remains stable across pages", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const p1 = await runDeviceList(
      parseDeviceListQuery({ mode: "bySite", site: "S-A", page: 1, pageSize: 5 }),
    );
    const p2 = await runDeviceList(
      parseDeviceListQuery({ mode: "bySite", site: "S-A", page: 2, pageSize: 5 }),
    );
    // S-A has 10 devices; page 1 = 5 rows, page 2 = 5 rows, total = 10 both pages
    expect(p1.total).toBe(10);
    expect(p2.total).toBe(10);
    expect(p1.rows).toHaveLength(5);
    expect(p2.rows).toHaveLength(5);
    // No overlap
    const names1 = new Set(p1.rows.map((r) => r.name));
    const names2 = new Set(p2.rows.map((r) => r.name));
    for (const n of names2) expect(names1.has(n)).toBe(false);
  });

  it("total matches filtered count regardless of page/pageSize", async () => {
    const { runDeviceList, parseDeviceListQuery } = await import(
      "@/lib/device-list"
    );
    const p1 = await runDeviceList(
      parseDeviceListQuery({
        mode: "byRole",
        role: "GPON",
        page: 1,
        pageSize: 3,
      }),
    );
    const p2 = await runDeviceList(
      parseDeviceListQuery({
        mode: "byRole",
        role: "GPON",
        page: 2,
        pageSize: 3,
      }),
    );
    expect(p1.total).toBe(8);
    expect(p2.total).toBe(8);
    expect(p1.rows).toHaveLength(3);
    expect(p2.rows).toHaveLength(3);
  });
});

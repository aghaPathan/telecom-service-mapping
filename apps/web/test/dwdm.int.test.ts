import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for lib/dwdm against a real Neo4j 5 container. Mirrors the
// pattern in test/path.int.test.ts — set NEO4J_* env vars before dynamically
// importing the resolver so the cached getDriver() singleton picks them up.

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

async function seed(driver: Driver) {
  const session = driver.session();
  try {
    await session.run(`MATCH (n) DETACH DELETE n`);
    await session.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    // Triangle in RING-1: A <-> B <-> C <-> A.
    // D in RING-2 connected only to A via DWDM (single ring-2 edge).
    // E connected to A by LLDP only (:CONNECTS_TO) — must be excluded from
    // any DWDM sub-graph result.
    await session.run(
      `CREATE
        (a:Device {name:'XX-AAA-DWDM-01', role:'DWDM', level:3, site:'AAA', domain:'D'}),
        (b:Device {name:'XX-BBB-DWDM-01', role:'DWDM', level:3, site:'BBB', domain:'D'}),
        (c:Device {name:'XX-CCC-DWDM-01', role:'DWDM', level:3, site:'CCC', domain:'D'}),
        (d:Device {name:'XX-DDD-DWDM-01', role:'DWDM', level:3, site:'DDD', domain:'D'}),
        (e:Device {name:'XX-EEE-CSG-01',  role:'CSG',  level:3, site:'EEE', domain:'D'}),
        (a)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-AB',
                         snfn_cids:['SNFN-1'], mobily_cids:['MOB-1'],
                         src_interface:'a-to-b', dst_interface:'b-to-a'}]->(b),
        (b)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-BC',
                         snfn_cids:['SNFN-2'], mobily_cids:[],
                         src_interface:'b-to-c', dst_interface:'c-to-b'}]->(c),
        (a)-[:DWDM_LINK {ring:'RING-1', span_name:'SPAN-AC',
                         snfn_cids:[], mobily_cids:['MOB-3'],
                         src_interface:'a-to-c', dst_interface:'c-to-a'}]->(c),
        (a)-[:DWDM_LINK {ring:'RING-2', span_name:'SPAN-AD',
                         snfn_cids:['SNFN-9'], mobily_cids:['MOB-9'],
                         src_interface:'a-to-d', dst_interface:'d-to-a'}]->(d),
        (a)-[:CONNECTS_TO {a_if:'a-e', b_if:'e-a'}]->(e)
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

describe("lib/dwdm against live Neo4j", () => {
  it("listDwdmLinks({}) returns all edges, ordered by a.name then b.name", async () => {
    const { listDwdmLinks } = await import("@/lib/dwdm");
    const rows = await listDwdmLinks({});
    expect(rows.length).toBe(4);
    // Ordered ascending by a_name then b_name. All four edges have
    // XX-AAA-* or XX-BBB-* as the lesser endpoint.
    const pairs = rows.map((r) => [r.a_name, r.b_name]);
    expect(pairs).toEqual([
      ["XX-AAA-DWDM-01", "XX-BBB-DWDM-01"],
      ["XX-AAA-DWDM-01", "XX-CCC-DWDM-01"],
      ["XX-AAA-DWDM-01", "XX-DDD-DWDM-01"],
      ["XX-BBB-DWDM-01", "XX-CCC-DWDM-01"],
    ]);
    // Property shape sanity on the first row.
    const first = rows[0]!;
    expect(first.ring).toBe("RING-1");
    expect(first.span_name).toBe("SPAN-AB");
    expect(first.snfn_cids).toEqual(["SNFN-1"]);
    expect(first.mobily_cids).toEqual(["MOB-1"]);
    expect(first.src_interface).toBe("a-to-b");
    expect(first.dst_interface).toBe("b-to-a");
    expect(first.a_role).toBe("DWDM");
    expect(first.a_level).toBe(3);
    expect(first.b_role).toBe("DWDM");
    expect(first.b_level).toBe(3);
  });

  it("listDwdmLinks({ ring }) filters by ring", async () => {
    const { listDwdmLinks } = await import("@/lib/dwdm");
    const rows = await listDwdmLinks({ ring: "RING-1" });
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.ring === "RING-1")).toBe(true);
  });

  it("listDwdmLinks({ device_a }) is case-insensitive substring on either endpoint", async () => {
    const { listDwdmLinks } = await import("@/lib/dwdm");
    // Lowercase "aa" matches XX-AAA-DWDM-01 (toLower CONTAINS toLower).
    const rows = await listDwdmLinks({ device_a: "aa" });
    expect(rows.length).toBe(3);
    // Substring matched on either endpoint: every returned row has AAA on
    // a-side or b-side. (In our seed AAA is always the a-side.)
    expect(
      rows.every(
        (r) => r.a_name.includes("AAA") || r.b_name.includes("AAA"),
      ),
    ).toBe(true);
  });

  it("listDwdmLinks({ span_name }) is case-insensitive substring", async () => {
    const { listDwdmLinks } = await import("@/lib/dwdm");
    const rows = await listDwdmLinks({ span_name: "span-ab" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.span_name).toBe("SPAN-AB");
  });

  it("listDwdmLinks with no matches returns []", async () => {
    const { listDwdmLinks } = await import("@/lib/dwdm");
    const rows = await listDwdmLinks({ ring: "NO-SUCH-RING" });
    expect(rows).toEqual([]);
  });

  it("getNodeDwdm returns the node + DWDM neighbours; LLDP-only neighbour excluded", async () => {
    const { getNodeDwdm } = await import("@/lib/dwdm");
    const g = await getNodeDwdm("XX-AAA-DWDM-01");
    const names = g.nodes.map((n) => n.name).sort();
    // AAA + its three DWDM neighbours (B, C, D). E is LLDP-only -> excluded.
    expect(names).toEqual([
      "XX-AAA-DWDM-01",
      "XX-BBB-DWDM-01",
      "XX-CCC-DWDM-01",
      "XX-DDD-DWDM-01",
    ]);
    expect(names).not.toContain("XX-EEE-CSG-01");
    // Edges: only the three DWDM edges incident to AAA (the BBB<->CCC edge
    // does NOT involve AAA, so it is not in this sub-graph).
    expect(g.edges.length).toBe(3);
    for (const e of g.edges) {
      expect([e.a, e.b]).toContain("XX-AAA-DWDM-01");
    }
    // Property shape on an edge.
    const ad = g.edges.find(
      (e) => e.a === "XX-AAA-DWDM-01" && e.b === "XX-DDD-DWDM-01",
    )!;
    expect(ad.ring).toBe("RING-2");
    expect(ad.span_name).toBe("SPAN-AD");
    expect(ad.snfn_cids).toEqual(["SNFN-9"]);
    expect(ad.mobily_cids).toEqual(["MOB-9"]);
  });

  it("getNodeDwdm with unknown name returns empty graph (does not throw)", async () => {
    const { getNodeDwdm } = await import("@/lib/dwdm");
    const g = await getNodeDwdm("XX-NONE-DWDM-99");
    expect(g).toEqual({ nodes: [], edges: [] });
  });

  it("getRingDwdm returns ring sub-graph; other rings excluded", async () => {
    const { getRingDwdm } = await import("@/lib/dwdm");
    const g = await getRingDwdm("RING-1");
    const names = g.nodes.map((n) => n.name).sort();
    // Triangle endpoints only — D is in RING-2.
    expect(names).toEqual([
      "XX-AAA-DWDM-01",
      "XX-BBB-DWDM-01",
      "XX-CCC-DWDM-01",
    ]);
    expect(names).not.toContain("XX-DDD-DWDM-01");
    expect(g.edges.length).toBe(3);
    expect(g.edges.every((e) => e.ring === "RING-1")).toBe(true);
  });

  it("getRingDwdm with unknown ring returns empty graph", async () => {
    const { getRingDwdm } = await import("@/lib/dwdm");
    const g = await getRingDwdm("NO-SUCH-RING");
    expect(g).toEqual({ nodes: [], edges: [] });
  });

  it("getRingDwdm matches edges regardless of stored direction (reverse-canonical)", async () => {
    // Mutation guard for the directed->undirected fix. Insert a RING-REV edge
    // stored as (greater)-[:DWDM_LINK]->(lesser) — reverse of the canonical
    // lesser->greater order the ingestor writes. With an undirected MATCH the
    // edge is found; with a directed `->` it would silently disappear.
    const session = adminDriver.session();
    try {
      await session.run(
        `CREATE
          (p:Device {name:'XX-PPP-DWDM-01', role:'DWDM', level:3, site:'PPP', domain:'D'}),
          (q:Device {name:'XX-QQQ-DWDM-01', role:'DWDM', level:3, site:'QQQ', domain:'D'}),
          // Reverse canonical: QQQ > PPP, but edge points QQQ -> PPP.
          (q)-[:DWDM_LINK {ring:'RING-REV', span_name:'SPAN-REV',
                           snfn_cids:[], mobily_cids:[],
                           src_interface:'q-to-p', dst_interface:'p-to-q'}]->(p)
        `,
      );
    } finally {
      await session.close();
    }
    const { getRingDwdm } = await import("@/lib/dwdm");
    const g = await getRingDwdm("RING-REV");
    expect(g.edges.length).toBe(1);
    expect(g.edges[0]!.ring).toBe("RING-REV");
    expect(g.edges[0]!.span_name).toBe("SPAN-REV");
    const names = g.nodes.map((n) => n.name).sort();
    expect(names).toEqual(["XX-PPP-DWDM-01", "XX-QQQ-DWDM-01"]);
  });
});

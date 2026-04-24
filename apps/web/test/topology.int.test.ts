import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for runEgoGraph + runCoreOverview against a real Neo4j 5
// container. Mirrors cluster.int.test.ts: set NEO4J_* env BEFORE dynamically
// importing the resolvers so getDriver()'s singleton picks them up.

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

    // Synthetic fixture (never real operator data):
    //   C1 (core, S1) — UPE1 — C2 (core, S2)
    //                   UPE1 — CSG1 — RAN1 — CUST1
    //   ISLAND (S3) — no edges
    await session.run(`
      CREATE
        (c1:Device:CORE {name:'C1', role:'CORE', level:1, site:'S1', domain:null}),
        (c2:Device:CORE {name:'C2', role:'CORE', level:1, site:'S2', domain:null}),
        (u1:Device:UPE  {name:'UPE1', role:'UPE', level:2, site:'S1', domain:null}),
        (cs1:Device:CSG {name:'CSG1', role:'CSG', level:3, site:'S1', domain:null}),
        (r1:Device:RAN  {name:'RAN1', role:'RAN', level:4, site:'S1', domain:null}),
        (cu1:Device:Customer {name:'CUST1', role:'Customer', level:5, site:'S1', domain:null}),
        (:Device {name:'ISLAND', role:'Unknown', level:5, site:'S3', domain:null}),
        (c1)-[:CONNECTS_TO]->(u1),
        (c2)-[:CONNECTS_TO]->(u1),
        (u1)-[:CONNECTS_TO]->(cs1),
        (cs1)-[:CONNECTS_TO]->(r1),
        (r1)-[:CONNECTS_TO]->(cu1)
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

function hasEdge(
  edges: Array<{ a: string; b: string }>,
  x: string,
  y: string,
): boolean {
  return edges.some(
    (e) => (e.a === x && e.b === y) || (e.a === y && e.b === x),
  );
}

describe("runEgoGraph against live Neo4j", () => {
  it("hops=1 around UPE1: includes C1, C2, CSG1; excludes RAN1/CUST1/ISLAND", async () => {
    const { runEgoGraph } = await import("@/lib/topology");
    const r = await runEgoGraph({ name: "UPE1", hops: 1 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const names = r.nodes.map((n) => n.name).sort();
    expect(names).toEqual(["C1", "C2", "CSG1", "UPE1"]);
    expect(hasEdge(r.edges, "UPE1", "C1")).toBe(true);
    expect(hasEdge(r.edges, "UPE1", "C2")).toBe(true);
    expect(hasEdge(r.edges, "UPE1", "CSG1")).toBe(true);
    expect(r.start.name).toBe("UPE1");
  });

  it("hops=2 around UPE1: also includes RAN1, still excludes CUST1/ISLAND", async () => {
    const { runEgoGraph } = await import("@/lib/topology");
    const r = await runEgoGraph({ name: "UPE1", hops: 2 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const names = r.nodes.map((n) => n.name).sort();
    expect(names).toContain("RAN1");
    expect(names).not.toContain("CUST1");
    expect(names).not.toContain("ISLAND");
    expect(hasEdge(r.edges, "CSG1", "RAN1")).toBe(true);
  });

  it("hops=3 around ISLAND: returns island alone, edges empty", async () => {
    const { runEgoGraph } = await import("@/lib/topology");
    const r = await runEgoGraph({ name: "ISLAND", hops: 3 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.nodes.map((n) => n.name)).toEqual(["ISLAND"]);
    expect(r.edges).toEqual([]);
  });

  it("unknown device name returns start_not_found", async () => {
    const { runEgoGraph } = await import("@/lib/topology");
    const r = await runEgoGraph({ name: "DOES-NOT-EXIST", hops: 1 });
    expect(r.status).toBe("start_not_found");
  });

  it("hops=99 throws (zod guard)", async () => {
    const { runEgoGraph } = await import("@/lib/topology");
    await expect(runEgoGraph({ name: "UPE1", hops: 99 })).rejects.toThrow();
  });
});

describe("runCoreOverview against live Neo4j", () => {
  it("returns cores + 1-hop neighbors (UPE1), excludes deeper tiers and islands", async () => {
    const { runCoreOverview } = await import("@/lib/topology");
    const r = await runCoreOverview();
    const names = r.nodes.map((n) => n.name).sort();
    expect(names).toEqual(["C1", "C2", "UPE1"]);
    expect(hasEdge(r.edges, "C1", "UPE1")).toBe(true);
    expect(hasEdge(r.edges, "C2", "UPE1")).toBe(true);
    // UPE1 ↔ CSG1 is outside the core+1-hop node set, must be excluded.
    expect(hasEdge(r.edges, "UPE1", "CSG1")).toBe(false);
  });
});

describe("runTopologyPath against live Neo4j", () => {
  // Local fixture kept separate from path.int.test.ts to avoid cross-file
  // coupling. Same A/Mid/B/Core topology: a same-level A<->B corridor via Mid
  // plus an A->Core / B->Core detour. The path mode resolver must return the
  // direct A->Mid->B corridor, not route through Core.
  async function seedTopologyD2D(driver: Driver) {
    const session = driver.session();
    try {
      await session.run(`MATCH (n) DETACH DELETE n`);
      await session.run(
        "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
      );
      await session.run(
        "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
      );
      await session.run(
        `CREATE
          (a:Device:UPE {name:'A', role:'UPE', level:2, site:'S', domain:'D'}),
          (b:Device:UPE {name:'B', role:'UPE', level:2, site:'S', domain:'D'}),
          (mid:Device:CSG {name:'Mid', role:'CSG', level:3, site:'S', domain:'D'}),
          (c:Device:CORE {name:'Core', role:'CORE', level:1, site:'S', domain:'D'}),
          (a)-[:CONNECTS_TO {a_if:'a-mid', b_if:'mid-a'}]->(mid),
          (mid)-[:CONNECTS_TO {a_if:'mid-b', b_if:'b-mid'}]->(b),
          (a)-[:CONNECTS_TO {a_if:'a-core', b_if:'core-a'}]->(c),
          (b)-[:CONNECTS_TO {a_if:'b-core', b_if:'core-b'}]->(c)
        `,
      );
    } finally {
      await session.close();
    }
  }

  it("path mode with from=A&to=B renders the A->B path not A->core", async () => {
    await seedTopologyD2D(adminDriver);
    const { runTopologyPath } = await import("@/lib/topology");
    const graph = await runTopologyPath({
      from: { kind: "device", value: "A" },
      to: { kind: "device", value: "B" },
    });
    const names = graph.nodes.map((n) => n.id).sort();
    expect(names).toEqual(["A", "B", "Mid"]);
    expect(graph.edges.length).toBe(2);
  });
});

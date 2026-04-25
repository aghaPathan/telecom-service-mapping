import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Integration test for getIsisFreshness against a real Neo4j 5 container.
// Mirrors apps/web/test/cluster.int.test.ts — env vars set before dynamic
// import so the lib's getDriver() singleton picks them up.

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

async function clear(driver: Driver) {
  const session = driver.session();
  try {
    await session.run("MATCH (n) DETACH DELETE n");
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

beforeEach(async () => {
  await clear(adminDriver);
});

describe("getIsisFreshness", () => {
  it("empty graph → { latestObservedAt: null, coveragePct: 0 }", async () => {
    const { getIsisFreshness } = await import("@/lib/isis-status");
    const r = await getIsisFreshness();
    expect(r.latestObservedAt).toBeNull();
    expect(r.coveragePct).toBe(0);
  });

  it("4 edges, 2 weighted → coveragePct=0.5, latestObservedAt=fresh", async () => {
    const fresh = "2026-04-01T00:00:00Z";
    const old = "2025-01-01T00:00:00Z";
    const session = adminDriver.session();
    try {
      // 4 directed :CONNECTS_TO edges between distinct device pairs.
      // 2 carry r.weight + r.weight_observed_at (one fresh, one old);
      // the other 2 are weight-less.
      await session.run(`
        CREATE
          (a:Device {name:'A'}),
          (b:Device {name:'B'}),
          (c:Device {name:'C'}),
          (d:Device {name:'D'}),
          (e:Device {name:'E'}),
          (f:Device {name:'F'}),
          (g:Device {name:'G'}),
          (h:Device {name:'H'}),
          (a)-[:CONNECTS_TO {weight: 10.0, weight_observed_at: datetime($fresh)}]->(b),
          (c)-[:CONNECTS_TO {weight: 20.0, weight_observed_at: datetime($old)}]->(d),
          (e)-[:CONNECTS_TO]->(f),
          (g)-[:CONNECTS_TO]->(h)
      `, { fresh, old });
    } finally {
      await session.close();
    }

    const { getIsisFreshness } = await import("@/lib/isis-status");
    const r = await getIsisFreshness();
    expect(r.coveragePct).toBeCloseTo(0.5, 6);
    expect(r.latestObservedAt).not.toBeNull();
    expect(r.latestObservedAt!.toISOString()).toBe(
      new Date(fresh).toISOString(),
    );
  });

  it("all weight-less edges → coveragePct=0, latestObservedAt=null", async () => {
    const session = adminDriver.session();
    try {
      await session.run(`
        CREATE
          (a:Device {name:'A'}),
          (b:Device {name:'B'}),
          (a)-[:CONNECTS_TO]->(b)
      `);
    } finally {
      await session.close();
    }
    const { getIsisFreshness } = await import("@/lib/isis-status");
    const r = await getIsisFreshness();
    expect(r.coveragePct).toBe(0);
    expect(r.latestObservedAt).toBeNull();
  });
});

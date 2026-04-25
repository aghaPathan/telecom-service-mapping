import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, StartedTestContainer } from "testcontainers";
import neo4j, { Driver } from "neo4j-driver";

// Issue #67 AC8: assert that after the ISIS-cost stage runs against an
// all-Huawei fixture, runPath returns weighted: true (PR #66's "unweighted
// path" banner stays hidden).
//
// We seed the graph state the ISIS-cost stage would produce — every edge on
// the candidate path carries `weight`, `weight_source: 'observed'`,
// `weight_observed_at: datetime()` — and call runPath directly. This avoids
// spinning up ClickHouse + the full ingestor; Task 7's
// cron-isis-flavor.int.test.ts already covers writeIsisWeights end-to-end.
// What matters here is the contract from path.ts: total_weight derived from
// non-null per-edge weights => weighted=true.

let neo4jC: StartedTestContainer;
let adminDriver: Driver;
const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

// All-Huawei chain mirrors the ISIS-cost stage's all-Huawei fixture framing.
// Hostnames follow the CLAUDE.md redaction convention (preserved-shape
// placeholders, not real operator codes).
const CUST = "XX-YYY-CUST-01";
const ACC = "XX-YYY-ACCESS-01";
const AGG = "XX-YYY-AGG-01";
const CORE = "XX-YYY-CORE-01";

async function resetSchema(driver: Driver): Promise<void> {
  const s = driver.session();
  try {
    await s.run("MATCH (n) DETACH DELETE n");
    await s.run(
      "CREATE CONSTRAINT device_name_unique IF NOT EXISTS FOR (d:Device) REQUIRE d.name IS UNIQUE",
    );
    await s.run(
      "CREATE INDEX device_level IF NOT EXISTS FOR (d:Device) ON (d.level)",
    );
  } finally {
    await s.close();
  }
}

interface EdgeWeight {
  weight: number | null;
  observed: boolean;
}

async function seedChain(driver: Driver, edges: [EdgeWeight, EdgeWeight, EdgeWeight]): Promise<void> {
  const s = driver.session();
  try {
    const params = {
      cust: CUST,
      acc: ACC,
      agg: AGG,
      core: CORE,
      w0: edges[0].weight,
      w1: edges[1].weight,
      w2: edges[2].weight,
      src0: edges[0].observed ? "observed" : null,
      src1: edges[1].observed ? "observed" : null,
      src2: edges[2].observed ? "observed" : null,
    };
    await s.run(
      `CREATE
        (cust:Device:CUSTOMER {name:$cust, role:'Customer', level:5, site:'S', domain:'D', vendor:'Huawei'}),
        (acc:Device:ACCESS    {name:$acc,  role:'Access',   level:3, site:'S', domain:'D', vendor:'Huawei'}),
        (agg:Device:AGG       {name:$agg,  role:'Aggregation', level:2, site:'S', domain:'D', vendor:'Huawei'}),
        (core:Device:CORE     {name:$core, role:'Core',     level:1, site:'S', domain:'D', vendor:'Huawei'}),
        (cust)-[:CONNECTS_TO {a_if:'cust-acc', b_if:'acc-cust', weight:$w0, weight_source:$src0, weight_observed_at: CASE WHEN $src0 IS NULL THEN null ELSE datetime() END}]->(acc),
        (acc)-[:CONNECTS_TO  {a_if:'acc-agg',  b_if:'agg-acc',  weight:$w1, weight_source:$src1, weight_observed_at: CASE WHEN $src1 IS NULL THEN null ELSE datetime() END}]->(agg),
        (agg)-[:CONNECTS_TO  {a_if:'agg-core', b_if:'core-agg', weight:$w2, weight_source:$src2, weight_observed_at: CASE WHEN $src2 IS NULL THEN null ELSE datetime() END}]->(core)
      `,
      params,
    );
  } finally {
    await s.close();
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
  await resetSchema(adminDriver);
});

describe("runPath weighted contract on all-Huawei ISIS-cost fixture (#67 AC8)", () => {
  it("all edges weighted (observed) -> weighted=true and total_weight > 0", async () => {
    await seedChain(adminDriver, [
      { weight: 10.0, observed: true },
      { weight: 20.0, observed: true },
      { weight: 30.0, observed: true },
    ]);
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: CUST, to: undefined });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.weighted).toBe(true);
    expect(r.total_weight).toBe(60);
    expect(r.length).toBe(3);
    expect(r.hops.map((h) => h.name)).toEqual([CUST, ACC, AGG, CORE]);
  });

  it("one edge unweighted -> set-level fallback yields weighted=false", async () => {
    // ADR 0004 null-propagation: if any candidate path has a null edge,
    // the whole result reports weighted=false.
    await seedChain(adminDriver, [
      { weight: 10.0, observed: true },
      { weight: null, observed: false },
      { weight: 30.0, observed: true },
    ]);
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: CUST, to: undefined });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.weighted).toBe(false);
    expect(r.total_weight).toBeNull();
  });

  it("no weights anywhere -> weighted=false", async () => {
    await seedChain(adminDriver, [
      { weight: null, observed: false },
      { weight: null, observed: false },
      { weight: null, observed: false },
    ]);
    const { runPath } = await import("@/lib/path");
    const r = await runPath({ kind: "device", value: CUST, to: undefined });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.weighted).toBe(false);
    expect(r.total_weight).toBeNull();
  });
});

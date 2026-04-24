import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import neo4j, { type Driver } from "neo4j-driver";
import { migrate, closePool as closeDbPool } from "@tsm/db";
import { getPool, closePool as closeWebPool } from "@/lib/postgres";

let pg: StartedPostgreSqlContainer;
let neo4jC: StartedTestContainer;
let adminDriver: Driver;

const NEO_USER = "neo4j";
const NEO_PASS = "testpass1234";

beforeAll(async () => {
  // Start Postgres
  pg = await new PostgreSqlContainer("postgres:13-alpine").start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate();

  // Seed 2 isolation rows
  await getPool().query(`
    INSERT INTO isolations (device_name, data_source, vendor, connected_nodes, load_dt)
    VALUES
      ('DEV-A', 'test', 'huawei', '{}', NOW()),
      ('DEV-B', 'test', 'nokia',  '{}', NOW())
  `);

  // Start Neo4j
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

  // Seed 3 huawei + 1 nokia devices
  const session = adminDriver.session();
  try {
    await session.run(`
      CREATE
        (:Device {name:'D1', vendor:'huawei', level:2}),
        (:Device {name:'D2', vendor:'huawei', level:3}),
        (:Device {name:'D3', vendor:'huawei', level:3}),
        (:Device {name:'D4', vendor:'nokia',  level:2})
    `);
  } finally {
    await session.close();
  }
}, 300_000);

afterAll(async () => {
  await adminDriver?.close();
  const { getDriver } = await import("@/lib/neo4j");
  try {
    await getDriver().close();
  } catch {
    /* already closed */
  }
  await closeDbPool();
  await closeWebPool();
  await neo4jC?.stop();
  await pg.stop();
}, 60_000);

describe("getHomeKpis", () => {
  it("returns totalDevices=4, byVendor={huawei:3,nokia:1}, isolationCount=2", async () => {
    const { getHomeKpis } = await import("@/lib/kpis");
    const kpis = await getHomeKpis();
    expect(kpis.totalDevices).toBe(4);
    expect(kpis.byVendor).toEqual({ huawei: 3, nokia: 1 });
    expect(kpis.isolationCount).toBe(2);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import pg from "pg";
import neo4j from "neo4j-driver";
import { createClient } from "@clickhouse/client";
import { migrate } from "@tsm/db";
import { tickCron } from "../src/cron.ts";
import { runIngest } from "../src/index.ts";
import type { IngestorConfig } from "../src/config.ts";
import type { TriggerFlavor } from "../src/triggers.ts";

const { Pool } = pg;

/**
 * Issue #67 task 7: cron honours `ingestion_triggers.flavor`.
 *
 * When a pending trigger has `flavor='isis_cost'`, the run MUST execute the
 * ISIS-cost stage in isolation — no source-DB read, no full graph rebuild,
 * no DETACH DELETE on :Device. The pre-seeded LLDP edge must keep its
 * existing :Device nodes and only have its `weight` updated.
 *
 * Source PG is intentionally NOT booted: this test asserts the isis_cost
 * branch never reaches the source reader.
 */
describe("tickCron honours trigger flavor (isis_cost path)", () => {
  let appPg: StartedTestContainer;
  let neo4jC: StartedTestContainer;
  let chC: StartedTestContainer;

  let appUrl: string;
  let neoUri: string;
  let chUrl: string;
  const neoUser = "neo4j";
  const neoPassword = "testpassword123";

  const A = "ISIS-CRON-CORE-01";
  const B = "ISIS-CRON-UPE-01";
  const IF_A = "Eth1";
  const IF_B = "Eth2";

  let pool: pg.Pool;

  /** Seed Neo4j with two :Device nodes + one :CONNECTS_TO edge (no weight). */
  async function seedGraph(): Promise<void> {
    const driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
    try {
      const s = driver.session();
      try {
        await s.run("MATCH (n) DETACH DELETE n");
        await s.run(
          `CREATE (a:Device {name: $a, level: 1})
           CREATE (b:Device {name: $b, level: 5})
           CREATE (a)-[:CONNECTS_TO {a_if: $ifa, b_if: $ifb}]->(b)`,
          { a: A, b: B, ifa: IF_A, ifb: IF_B },
        );
      } finally {
        await s.close();
      }
    } finally {
      await driver.close();
    }
  }

  async function seedClickHouse(weight: number): Promise<void> {
    const client = createClient({
      url: chUrl,
      username: "default",
      password: "",
      request_timeout: 30_000,
    });
    try {
      await client.command({ query: "DROP DATABASE IF EXISTS lldp_data" });
      await client.command({ query: "CREATE DATABASE lldp_data" });
      await client.command({
        query: `
          CREATE TABLE lldp_data.isis_cost (
            Device_A_Name      Nullable(String),
            Device_A_Interface Nullable(String),
            ISIS_COST          Nullable(Int64),
            Device_B_Name      Nullable(String),
            Device_B_Interface Nullable(String),
            Vendor             String,
            RecordDateTime     DateTime
          ) ENGINE = MergeTree()
            ORDER BY (RecordDateTime)
        `,
      });
      await client.insert({
        table: "lldp_data.isis_cost",
        format: "JSONEachRow",
        values: [
          {
            Device_A_Name: A,
            Device_A_Interface: IF_A,
            ISIS_COST: weight,
            Device_B_Name: B,
            Device_B_Interface: IF_B,
            Vendor: "Huawei",
            RecordDateTime: "2025-02-14 00:00:00",
          },
        ],
      });
    } finally {
      await client.close();
    }
  }

  async function readEdgeWeight(): Promise<number | null> {
    const driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
    try {
      const s = driver.session();
      try {
        const r = await s.run(
          `MATCH (:Device {name: $a})-[r:CONNECTS_TO]-(:Device {name: $b})
           RETURN r.weight AS w LIMIT 1`,
          { a: A, b: B },
        );
        if (r.records.length === 0) return null;
        const w = r.records[0]!.get("w");
        if (w === null || w === undefined) return null;
        return typeof w === "number" ? w : w.toNumber?.() ?? Number(w);
      } finally {
        await s.close();
      }
    } finally {
      await driver.close();
    }
  }

  async function countDevices(): Promise<number> {
    const driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
    try {
      const s = driver.session();
      try {
        const r = await s.run("MATCH (d:Device) RETURN count(d) AS n");
        const n = r.records[0]!.get("n");
        return typeof n === "number" ? n : n.toNumber?.() ?? Number(n);
      } finally {
        await s.close();
      }
    } finally {
      await driver.close();
    }
  }

  function baseConfig(extra?: Partial<IngestorConfig>): IngestorConfig {
    return {
      DATABASE_URL: appUrl,
      // Source URL intentionally points at an unreachable host — proves the
      // isis_cost branch never tries to read it.
      DATABASE_URL_SOURCE: "postgres://nope:nope@127.0.0.1:1/nope",
      NEO4J_URI: neoUri,
      NEO4J_USER: neoUser,
      NEO4J_PASSWORD: neoPassword,
      INGEST_MODE: "full",
      INGEST_CRON: "0 2 * * *",
      ...extra,
    };
  }

  beforeAll(async () => {
    appPg = await new GenericContainer("postgres:13-alpine")
      .withEnvironment({
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "app",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(
          /database system is ready to accept connections/,
          2,
        ),
      )
      .start();

    neo4jC = await new GenericContainer("neo4j:5-community")
      .withEnvironment({ NEO4J_AUTH: `${neoUser}/${neoPassword}` })
      .withExposedPorts(7687, 7474)
      .withWaitStrategy(Wait.forLogMessage(/Started\./))
      .withStartupTimeout(120_000)
      .start();

    chC = await new GenericContainer("clickhouse/clickhouse-server:22.3")
      .withExposedPorts(8123, 9000)
      .withEnvironment({
        CLICKHOUSE_DB: "default",
        CLICKHOUSE_USER: "default",
        CLICKHOUSE_PASSWORD: "",
      })
      .withWaitStrategy(Wait.forHttp("/ping", 8123).forStatusCode(200))
      .withStartupTimeout(180_000)
      .start();

    appUrl = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(5432)}/app`;
    neoUri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;
    chUrl = `http://${chC.getHost()}:${chC.getMappedPort(8123)}`;

    await migrate(appUrl);
    pool = new Pool({ connectionString: appUrl, max: 2 });
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ('00000000-0000-0000-0000-000000000001', 'a@b.c', 'x', 'admin')
       ON CONFLICT DO NOTHING`,
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await Promise.allSettled([appPg?.stop(), neo4jC?.stop(), chC?.stop()]);
  }, 60_000);

  it("isis_cost flavor: only ISIS stage runs, graph not rebuilt, weight set", async () => {
    await pool.query("TRUNCATE ingestion_runs RESTART IDENTITY CASCADE");
    await pool.query("TRUNCATE ingestion_triggers RESTART IDENTITY");
    await seedGraph();
    await seedClickHouse(11);

    const devicesBefore = await countDevices();
    expect(devicesBefore).toBe(2);

    await pool.query(
      `INSERT INTO ingestion_triggers (requested_by, flavor) VALUES
         ('00000000-0000-0000-0000-000000000001', 'isis_cost')`,
    );

    const config = baseConfig({
      clickhouse: {
        url: chUrl,
        user: "default",
        password: "",
        database: "lldp_data",
        isisTable: "isis_cost",
        timeoutMs: 30_000,
      },
    });

    const outcome = await tickCron(
      pool,
      async (flavor: TriggerFlavor): Promise<number | null> => {
        const r = await runIngest({ dryRun: false, config, flavor });
        return r.runId;
      },
    );
    expect(outcome.action).toBe("ran");

    // Graph not rebuilt — count of :Device unchanged (full path would
    // DETACH DELETE everything and rebuild from the unreachable source).
    const devicesAfter = await countDevices();
    expect(devicesAfter).toBe(2);

    // ISIS weight applied to the pre-seeded edge.
    expect(await readEdgeWeight()).toBe(11);

    // Run row succeeded with no isis_cost_failure warning.
    const { rows } = await pool.query<{
      status: string;
      warnings_json: unknown[];
    }>(
      `SELECT status, warnings_json FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe("succeeded");
    const failures = (rows[0]!.warnings_json as unknown[]).filter(
      (w) => (w as { kind?: string }).kind === "isis_cost_failure",
    );
    expect(failures).toHaveLength(0);
  }, 120_000);

  it("isis_cost flavor + clickhouse undefined: succeeds with clickhouse_not_configured warning", async () => {
    await pool.query("TRUNCATE ingestion_runs RESTART IDENTITY CASCADE");
    await pool.query("TRUNCATE ingestion_triggers RESTART IDENTITY");
    await seedGraph();

    await pool.query(
      `INSERT INTO ingestion_triggers (requested_by, flavor) VALUES
         ('00000000-0000-0000-0000-000000000001', 'isis_cost')`,
    );

    const config = baseConfig(); // clickhouse omitted

    const outcome = await tickCron(
      pool,
      async (flavor: TriggerFlavor): Promise<number | null> => {
        const r = await runIngest({ dryRun: false, config, flavor });
        return r.runId;
      },
    );
    expect(outcome.action).toBe("ran");

    // Graph not touched.
    expect(await countDevices()).toBe(2);
    expect(await readEdgeWeight()).toBeNull();

    const { rows } = await pool.query<{
      status: string;
      warnings_json: unknown[];
    }>(
      `SELECT status, warnings_json FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe("succeeded");
    const failures = (rows[0]!.warnings_json as unknown[]).filter(
      (w) => (w as { kind?: string }).kind === "isis_cost_failure",
    );
    expect(failures).toHaveLength(1);
    expect((failures[0] as { error: string }).error).toBe(
      "clickhouse_not_configured",
    );
  }, 120_000);
});

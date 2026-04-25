import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import neo4j, { type Driver } from "neo4j-driver";
import { createClient } from "@clickhouse/client";
import { runIngest } from "../src/index.ts";
import type { IngestorConfig } from "../src/config.ts";

const { Client } = pg;

/**
 * Issue #67 task 6: integration tests for the ISIS-cost stage wired into
 * runIngest. The stage MUST be safe-fail — a ClickHouse outage records a
 * structured warning but never fails the run nor corrupts existing
 * `:CONNECTS_TO.weight` values.
 */
describe("isis-cost stage in runIngest (testcontainers)", () => {
  let sourcePg: StartedTestContainer;
  let appPg: StartedTestContainer;
  let neo4jC: StartedTestContainer;
  let chC: StartedTestContainer;

  let sourceUrl: string;
  let appUrl: string;
  let neoUri: string;
  let chUrl: string;
  const neoUser = "neo4j";
  const neoPassword = "testpassword123";

  // Two devices wired by a single LLDP edge — the seed for every test below.
  // The ISIS happy-path row targets this exact (name, interface) pair.
  const A = "ISIS-CORE-01";
  const B = "ISIS-UPE-01";
  const IF_A = "Eth1";
  const IF_B = "Eth2";

  /** Seed source PG `app_lldp` with one row that produces one canonical edge. */
  async function seedSource(): Promise<void> {
    const sc = new Client({ connectionString: sourceUrl });
    await sc.connect();
    try {
      await sc.query(
        `TRUNCATE app_lldp, app_cid, app_devicecid, app_sitesportal, dwdm`,
      );
      await sc.query(
        `INSERT INTO app_lldp (
           device_a_name, device_a_interface,
           device_b_name, device_b_interface,
           type_a, type_b,
           updated_at, status
         ) VALUES ($1,$2,$3,$4,'TCOR','TUPE', now(), true)`,
        [A, IF_A, B, IF_B],
      );
    } finally {
      await sc.end();
    }
  }

  /** Seed CH `lldp_data.isis_cost` with one matching row. */
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

  /** Read `weight` (and `weight_source`) on the canonical CONNECTS_TO edge. */
  async function readEdgeWeight(): Promise<{
    weight: number | null;
    source: string | null;
  }> {
    const driver = neo4j.driver(
      neoUri,
      neo4j.auth.basic(neoUser, neoPassword),
    );
    try {
      const s = driver.session();
      try {
        const r = await s.run(
          `MATCH (:Device {name: $a})-[r:CONNECTS_TO]-(:Device {name: $b})
           RETURN r.weight AS w, r.weight_source AS src LIMIT 1`,
          { a: A, b: B },
        );
        if (r.records.length === 0) return { weight: null, source: null };
        const w = r.records[0]!.get("w");
        return {
          weight:
            w === null || w === undefined
              ? null
              : typeof w === "number"
                ? w
                : w.toNumber?.() ?? Number(w),
          source: r.records[0]!.get("src") as string | null,
        };
      } finally {
        await s.close();
      }
    } finally {
      await driver.close();
    }
  }

  /** Read warnings_json for an ingestion run. */
  async function readWarnings(runId: number): Promise<unknown[]> {
    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows } = await ac.query(
        "SELECT warnings_json FROM ingestion_runs WHERE id = $1",
        [runId],
      );
      return (rows[0]?.warnings_json as unknown[]) ?? [];
    } finally {
      await ac.end();
    }
  }

  function baseConfig(extra?: Partial<IngestorConfig>): IngestorConfig {
    return {
      DATABASE_URL: appUrl,
      DATABASE_URL_SOURCE: sourceUrl,
      NEO4J_URI: neoUri,
      NEO4J_USER: neoUser,
      NEO4J_PASSWORD: neoPassword,
      INGEST_MODE: "full",
      INGEST_CRON: "0 2 * * *",
      ...extra,
    };
  }

  beforeAll(async () => {
    sourcePg = await new GenericContainer("postgres:13-alpine")
      .withEnvironment({
        POSTGRES_USER: "source",
        POSTGRES_PASSWORD: "source",
        POSTGRES_DB: "source",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(
          /database system is ready to accept connections/,
          2,
        ),
      )
      .start();

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

    sourceUrl = `postgres://source:source@${sourcePg.getHost()}:${sourcePg.getMappedPort(5432)}/source`;
    appUrl = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(5432)}/app`;
    neoUri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;
    chUrl = `http://${chC.getHost()}:${chC.getMappedPort(8123)}`;

    // Provision the source-DB tables that the ingestor reads. Schema mirrors
    // the larger ingest.int.test.ts harness.
    const sc = new Client({ connectionString: sourceUrl });
    await sc.connect();
    try {
      await sc.query(`
        CREATE TABLE app_sitesportal (
          site_name TEXT PRIMARY KEY, category TEXT, site_url TEXT
        );
        CREATE TABLE app_cid (
          cid TEXT PRIMARY KEY, capacity TEXT, source TEXT, dest TEXT,
          bandwidth TEXT, protection_type TEXT, protection_cid TEXT,
          mobily_cid TEXT, region TEXT
        );
        CREATE TABLE dwdm (
          device_a_name TEXT, device_a_interface TEXT, device_a_ip TEXT,
          device_b_name TEXT, device_b_interface TEXT, device_b_ip TEXT,
          "Ring" TEXT, snfn_cids TEXT, mobily_cids TEXT, span_name TEXT
        );
        CREATE TABLE app_devicecid (
          cid TEXT, device_a_name TEXT, device_b_name TEXT
        );
        CREATE TABLE app_lldp (
          id SERIAL PRIMARY KEY,
          device_a_name TEXT, device_a_interface TEXT, device_a_trunk_name TEXT,
          device_a_ip TEXT, device_a_mac TEXT,
          device_b_name TEXT, device_b_interface TEXT,
          device_b_ip TEXT, device_b_mac TEXT,
          vendor_a TEXT, vendor_b TEXT,
          domain_a TEXT, domain_b TEXT,
          type_a TEXT, type_b TEXT,
          updated_at TIMESTAMPTZ NOT NULL,
          status BOOLEAN NOT NULL DEFAULT true
        );
      `);
    } finally {
      await sc.end();
    }
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([
      sourcePg?.stop(),
      appPg?.stop(),
      neo4jC?.stop(),
      chC?.stop(),
    ]);
  }, 60_000);

  it("happy path — succeeds, sets weight, no isis_cost warning", async () => {
    await seedSource();
    await seedClickHouse(7);

    const result = await runIngest({
      dryRun: false,
      config: baseConfig({
        clickhouse: {
          url: chUrl,
          user: "default",
          password: "",
          database: "lldp_data",
          isisTable: "isis_cost",
          timeoutMs: 30_000,
        },
      }),
    });

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    let status: string;
    try {
      const { rows } = await ac.query(
        "SELECT status FROM ingestion_runs WHERE id=$1",
        [result.runId],
      );
      status = rows[0].status;
    } finally {
      await ac.end();
    }
    expect(status).toBe("succeeded");

    const edge = await readEdgeWeight();
    expect(edge.weight).toBe(7);
    expect(edge.source).toBe("observed");

    const warnings = await readWarnings(result.runId);
    const isis = warnings.filter(
      (w) => (w as { stage?: string }).stage === "isis_cost",
    );
    expect(isis).toHaveLength(0);
  });

  it("failure path — refused CH connection records warning, run succeeds, edge weight not corrupted", async () => {
    // writeGraph DETACH DELETEs all :Device nodes at the start of every run
    // (full-refresh contract), so we cannot verify "weight unchanged across
    // runs" by pre-seeding a weight before a second run — the wipe destroys
    // any pre-existing weight by design. Instead, the invariant we verify
    // here is the in-run isolation: a failing ISIS stage MUST NOT set any
    // weight on the freshly-rebuilt edges (so `weight=null` afterwards),
    // and the run still finishes `succeeded` with the error captured in
    // warnings_json.
    await seedSource();

    const result = await runIngest({
      dryRun: false,
      config: baseConfig({
        clickhouse: {
          // 127.0.0.1:1 reliably refuses connections — the CH client throws.
          url: "http://127.0.0.1:1",
          user: "default",
          password: "",
          database: "lldp_data",
          isisTable: "isis_cost",
          timeoutMs: 2000,
        },
      }),
    });

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    let status: string;
    try {
      const { rows } = await ac.query(
        "SELECT status FROM ingestion_runs WHERE id=$1",
        [result.runId],
      );
      status = rows[0].status;
    } finally {
      await ac.end();
    }
    expect(status).toBe("succeeded");

    // Edge exists (writeGraph ran), but no weight was set (ISIS stage threw
    // before reaching writeIsisWeights). `weight_source` stays null too —
    // the writer only sets it on successful MATCH.
    const afterEdge = await readEdgeWeight();
    expect(afterEdge.weight).toBeNull();
    expect(afterEdge.source).toBeNull();

    const warnings = await readWarnings(result.runId);
    const isis = warnings.filter(
      (w) => (w as { stage?: string }).stage === "isis_cost",
    );
    expect(isis).toHaveLength(1);
    const entry = isis[0] as { stage: string; error: string };
    expect(entry.stage).toBe("isis_cost");
    expect(typeof entry.error).toBe("string");
    expect(entry.error.length).toBeGreaterThan(0);
  });

  it("disabled path — clickhouse omitted, no isis warnings, run succeeds", async () => {
    await seedSource();

    const result = await runIngest({
      dryRun: false,
      config: baseConfig(), // clickhouse omitted
    });

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    let status: string;
    try {
      const { rows } = await ac.query(
        "SELECT status FROM ingestion_runs WHERE id=$1",
        [result.runId],
      );
      status = rows[0].status;
    } finally {
      await ac.end();
    }
    expect(status).toBe("succeeded");

    const warnings = await readWarnings(result.runId);
    const isis = warnings.filter(
      (w) => (w as { stage?: string }).stage === "isis_cost",
    );
    expect(isis).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import neo4j, { type Driver } from "neo4j-driver";
import { runIngest } from "../src/index.ts";
import { dedupLldpRows, type RawLldpRow } from "../src/dedup.ts";
import { FIXTURE } from "./fixtures/lldp-50.ts";

const { Client } = pg;

describe("ingest integration (testcontainers)", () => {
  let sourcePg: StartedTestContainer;
  let appPg: StartedTestContainer;
  let neo4jC: StartedTestContainer;

  let sourceUrl: string;
  let appUrl: string;
  let neoUri: string;
  const neoUser = "neo4j";
  const neoPassword = "testpassword123";

  beforeAll(async () => {
    // Start source Postgres (app_lldp seed).
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

    // Start app Postgres (migrations + ingestion_runs).
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

    // Start Neo4j.
    neo4jC = await new GenericContainer("neo4j:5-community")
      .withEnvironment({
        NEO4J_AUTH: `${neoUser}/${neoPassword}`,
      })
      .withExposedPorts(7687, 7474)
      .withWaitStrategy(Wait.forLogMessage(/Started\./))
      .withStartupTimeout(120_000)
      .start();

    sourceUrl = `postgres://source:source@${sourcePg.getHost()}:${sourcePg.getMappedPort(5432)}/source`;
    appUrl = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(5432)}/app`;
    neoUri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;

    // Seed source `app_lldp` with the fixture rows (+ 2 rows at status=false
    // to verify the filter).
    const sc = new Client({ connectionString: sourceUrl });
    await sc.connect();
    try {
      await sc.query(`
        CREATE TABLE app_lldp (
          id                   SERIAL PRIMARY KEY,
          device_a_name        TEXT,
          device_a_interface   TEXT,
          device_a_trunk_name  TEXT,
          device_a_ip          TEXT,
          device_a_mac         TEXT,
          device_b_name        TEXT,
          device_b_interface   TEXT,
          device_b_ip          TEXT,
          device_b_mac         TEXT,
          vendor_a             TEXT,
          vendor_b             TEXT,
          domain_a             TEXT,
          domain_b             TEXT,
          updated_at           TIMESTAMPTZ NOT NULL,
          status               BOOLEAN NOT NULL DEFAULT true
        );
      `);
      for (const r of FIXTURE) {
        await sc.query(
          `INSERT INTO app_lldp (
             device_a_name, device_a_interface, device_a_trunk_name,
             device_a_ip, device_a_mac,
             device_b_name, device_b_interface,
             device_b_ip, device_b_mac,
             vendor_a, vendor_b, domain_a, domain_b,
             updated_at, status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
          [
            r.device_a_name,
            r.device_a_interface,
            r.device_a_trunk_name,
            r.device_a_ip,
            r.device_a_mac,
            r.device_b_name,
            r.device_b_interface,
            r.device_b_ip,
            r.device_b_mac,
            r.vendor_a,
            r.vendor_b,
            r.domain_a,
            r.domain_b,
            r.updated_at,
          ],
        );
      }
      // Two inactive rows that MUST be excluded by `status = true` filter.
      await sc.query(
        `INSERT INTO app_lldp (
           device_a_name, device_a_interface, device_b_name, device_b_interface,
           updated_at, status
         ) VALUES
           ('XX-ZZZ-STALE-01','Gi0/1','XX-ZZZ-STALE-02','Gi0/1', now(), false),
           ('XX-ZZZ-STALE-03','Gi0/1','XX-ZZZ-STALE-04','Gi0/1', now(), false)`,
      );
    } finally {
      await sc.end();
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled([
      sourcePg?.stop(),
      appPg?.stop(),
      neo4jC?.stop(),
    ]);
  }, 60_000);

  it("full round-trip: source pg → dedup → neo4j, metadata in app pg", async () => {
    // Derive expected counts from the same pure function the ingestor uses
    // — avoids brittle hard-coded numbers if the fixture evolves.
    const expected = dedupLldpRows(FIXTURE as unknown as RawLldpRow[]);

    const result = await runIngest({
      dryRun: false,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });

    expect(result.dryRun).toBe(false);
    // Source read honored status=true (only 50 fixture rows, not 52).
    expect(result.sourceRows).toBe(50);
    expect(result.dropped).toEqual(expected.dropped);
    expect(result.warnings).toHaveLength(expected.warnings.length);
    expect(result.graph.nodes).toBe(expected.devices.length);
    expect(result.graph.edges).toBe(expected.links.length);

    // Verify Neo4j actually holds the graph.
    const driver: Driver = neo4j.driver(
      neoUri,
      neo4j.auth.basic(neoUser, neoPassword),
    );
    try {
      const sess = driver.session();
      try {
        const nodeRes = await sess.run(
          "MATCH (d:Device) RETURN count(d) AS c",
        );
        expect(nodeRes.records[0]!.get("c").toNumber()).toBe(
          expected.devices.length,
        );

        const edgeRes = await sess.run(
          "MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS c",
        );
        expect(edgeRes.records[0]!.get("c").toNumber()).toBe(
          expected.links.length,
        );

        // Unicode round-trip.
        const uni = await sess.run(
          "MATCH (d:Device) WHERE d.name IN ['Δ-CORE-01','日本-UPE-01'] RETURN d.name AS name",
        );
        const uniNames = uni.records.map((r) => r.get("name")).sort();
        expect(uniNames).toEqual(["Δ-CORE-01", "日本-UPE-01"]);

        // Mixed-case merge preserved first-seen casing.
        const mc = await sess.run(
          "MATCH (d:Device) WHERE toLower(d.name) = 'xx-hhh-core-01' RETURN d.name AS name",
        );
        expect(mc.records).toHaveLength(1);
        expect(mc.records[0]!.get("name")).toBe("XX-HHH-CORE-01");
      } finally {
        await sess.close();
      }
    } finally {
      await driver.close();
    }

    // Verify ingestion_runs row.
    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows } = await ac.query(
        `SELECT status, dry_run, source_rows_read,
                rows_dropped_null_b, rows_dropped_self_loop, rows_dropped_anomaly,
                graph_nodes_written, graph_edges_written, warnings_json
         FROM ingestion_runs WHERE id = $1`,
        [result.runId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("succeeded");
      expect(row.dry_run).toBe(false);
      expect(row.source_rows_read).toBe(50);
      expect(row.rows_dropped_null_b).toBe(expected.dropped.null_b);
      expect(row.rows_dropped_self_loop).toBe(expected.dropped.self_loop);
      expect(row.rows_dropped_anomaly).toBe(expected.dropped.anomaly);
      expect(row.graph_nodes_written).toBe(expected.devices.length);
      expect(row.graph_edges_written).toBe(expected.links.length);
      // warnings_json is stored as a jsonb; pg returns it already parsed.
      expect(Array.isArray(row.warnings_json)).toBe(true);
      expect(row.warnings_json).toHaveLength(expected.warnings.length);
    } finally {
      await ac.end();
    }
  });

  it("dry-run writes nothing to Neo4j but still records a run row", async () => {
    const driver = neo4j.driver(
      neoUri,
      neo4j.auth.basic(neoUser, neoPassword),
    );
    let before: number;
    {
      const s = driver.session();
      try {
        const r = await s.run("MATCH (d:Device) RETURN count(d) AS c");
        before = r.records[0]!.get("c").toNumber();
      } finally {
        await s.close();
      }
    }

    const result = await runIngest({
      dryRun: true,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.graph).toEqual({ nodes: 0, edges: 0 });

    let after: number;
    try {
      const s = driver.session();
      try {
        const r = await s.run("MATCH (d:Device) RETURN count(d) AS c");
        after = r.records[0]!.get("c").toNumber();
      } finally {
        await s.close();
      }
    } finally {
      await driver.close();
    }
    expect(after).toBe(before);

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows } = await ac.query(
        "SELECT status, dry_run FROM ingestion_runs WHERE id = $1",
        [result.runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("succeeded");
      expect(rows[0].dry_run).toBe(true);
    } finally {
      await ac.end();
    }
  });
});

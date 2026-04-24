import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import { readActiveLldpRows } from "../src/source/lldp.ts";

const { Client } = pg;

describe("readActiveLldpRows — NULL updated_at handling", () => {
  let sourcePg: StartedTestContainer;
  let sourceUrl: string;

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
    sourceUrl = `postgres://source:source@${sourcePg.getHost()}:${sourcePg.getMappedPort(5432)}/source`;

    // Mirror the real source schema: updated_at is nullable in production
    // (the observed live DB has 100% NULL values on this column).
    const c = new Client({ connectionString: sourceUrl });
    await c.connect();
    try {
      await c.query(`
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
          type_a               TEXT,
          type_b               TEXT,
          updated_at           TIMESTAMPTZ,
          status               BOOLEAN NOT NULL DEFAULT true
        );
        INSERT INTO app_lldp
          (device_a_name, device_a_interface, device_b_name, device_b_interface,
           updated_at, status)
        VALUES
          ('XX-AAA-CORE-01', 'Gi0/1', 'XX-AAA-CORE-02', 'Gi0/2', NULL, true),
          ('XX-BBB-CORE-01', 'Gi0/1', 'XX-BBB-CORE-02', 'Gi0/2', NULL, true);
      `);
    } finally {
      await c.end();
    }
  }, 180_000);

  afterAll(async () => {
    await sourcePg?.stop();
  });

  it("returns a valid Date for rows with NULL updated_at", async () => {
    const rows = await readActiveLldpRows(sourceUrl);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.updated_at).toBeInstanceOf(Date);
      expect(Number.isNaN(r.updated_at.getTime())).toBe(false);
    }
  });

  it("rulePORT: status=false rows excluded at source; status=NULL rows included (V1 compat)", async () => {
    // Alter the column to allow NULLs (mirrors V1 schemas where NOT NULL was absent),
    // then seed three rows: true (included), false (excluded), NULL (included).
    const c = new Client({ connectionString: sourceUrl });
    await c.connect();
    try {
      await c.query(`
        ALTER TABLE app_lldp ALTER COLUMN status DROP NOT NULL;
        INSERT INTO app_lldp
          (device_a_name, device_a_interface, device_b_name, device_b_interface,
           updated_at, status)
        VALUES
          ('STATUS-TRUE-A', 'Gi0/1', 'STATUS-TRUE-B',  'Gi0/2', NOW(), true),
          ('STATUS-FALSE-A','Gi0/1', 'STATUS-FALSE-B', 'Gi0/2', NOW(), false),
          ('STATUS-NULL-A', 'Gi0/1', 'STATUS-NULL-B',  'Gi0/2', NOW(), NULL)
      `);
    } finally {
      await c.end();
    }

    const rows = await readActiveLldpRows(sourceUrl);
    // beforeAll seeded 2 rows with status=true.
    // New rows: +1 status=true (included), +1 status=false (excluded), +1 status=NULL (included).
    // Total expected: 2 + 1 + 1 = 4. The status=false row must not appear.
    expect(rows).toHaveLength(4);
    const names = rows.flatMap((r) => [r.device_a_name, r.device_b_name]);
    expect(names).not.toContain("STATUS-FALSE-A");
    expect(names).not.toContain("STATUS-FALSE-B");
    expect(names).toContain("STATUS-TRUE-A");
    expect(names).toContain("STATUS-NULL-A");
  });
});

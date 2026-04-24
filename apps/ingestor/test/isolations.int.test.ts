import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import { migrate } from "@tsm/db";
import { writeIsolations } from "../src/isolations-writer.ts";
import type { SourceIsolationRow } from "../src/source/isolations.ts";

const { Pool, Client } = pg;

describe("writeIsolations integration (testcontainers)", () => {
  let appPg: StartedTestContainer;
  let appUrl: string;
  let pool: InstanceType<typeof Pool>;

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

    appUrl = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(5432)}/app`;

    // Apply migrations so the isolations table exists.
    await migrate(appUrl);

    pool = new Pool({ connectionString: appUrl });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await appPg?.stop();
  }, 60_000);

  it("inserts rows and full-refreshes on second call", async () => {
    const rowA: SourceIsolationRow = {
      device_name: "DEV-A",
      data_source: "source-1",
      vendor: "Huawei",
      connected_nodes: ["B", "C"],
    };

    // First write: one row.
    await writeIsolations(pool, [rowA]);

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows: after1 } = await ac.query(
        "SELECT device_name, data_source, vendor, connected_nodes FROM isolations",
      );
      expect(after1).toHaveLength(1);
      expect(after1[0].device_name).toBe("DEV-A");
      expect(after1[0].data_source).toBe("source-1");
      expect(after1[0].vendor).toBe("Huawei");
      // TEXT[] round-trip: pg returns a JS array.
      expect(after1[0].connected_nodes).toEqual(["B", "C"]);

      const rowX: SourceIsolationRow = {
        device_name: "DEV-X",
        data_source: "source-2",
        vendor: "Nokia",
        connected_nodes: ["D", "E", "F"],
      };

      // Second write: TRUNCATE+INSERT replaces the first set.
      await writeIsolations(pool, [rowX]);

      const { rows: after2 } = await ac.query(
        "SELECT device_name, connected_nodes FROM isolations",
      );
      // Full-refresh: count is still 1 (not 2).
      expect(after2).toHaveLength(1);
      expect(after2[0].device_name).toBe("DEV-X");
      expect(after2[0].connected_nodes).toEqual(["D", "E", "F"]);
    } finally {
      await ac.end();
    }
  });

  it("handles empty rows array (TRUNCATE only, no INSERT)", async () => {
    // Pre-seed so we can verify the table is emptied.
    await writeIsolations(pool, [
      { device_name: "PRE", data_source: null, vendor: null, connected_nodes: [] },
    ]);

    // Now write empty — should TRUNCATE and leave 0 rows.
    await writeIsolations(pool, []);

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows } = await ac.query("SELECT COUNT(*) AS c FROM isolations");
      expect(Number(rows[0].c)).toBe(0);
    } finally {
      await ac.end();
    }
  });
});

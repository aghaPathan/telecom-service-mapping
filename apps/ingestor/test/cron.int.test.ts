import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import pg from "pg";
import { migrate } from "@tsm/db";
import { tickCron } from "../src/cron.ts";
import { startRun, finishRun } from "../src/runs.ts";

const { Pool } = pg;

describe("cron tick (skip-when-overlapping)", () => {
  let appPg: StartedTestContainer;
  let pool: pg.Pool;

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

    const url = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(
      5432,
    )}/app`;
    await migrate(url);
    pool = new Pool({ connectionString: url, max: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await appPg?.stop();
  }, 30_000);

  it("runs when no prior run is in flight", async () => {
    await pool.query("TRUNCATE ingestion_runs RESTART IDENTITY");
    let ran = false;
    const outcome = await tickCron(pool, async () => {
      ran = true;
    });
    expect(outcome.action).toBe("ran");
    expect(ran).toBe(true);
  });

  it("skips and records a skip row when a prior run is still 'running'", async () => {
    await pool.query("TRUNCATE ingestion_runs RESTART IDENTITY");
    // Simulate a prior run that never finished.
    const runningId = await startRun(pool, { dryRun: false });

    let ran = false;
    const outcome = await tickCron(pool, async () => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(outcome.action).toBe("skipped");

    const { rows } = await pool.query<{
      id: number;
      status: string;
      skipped: boolean;
      warnings_json: unknown[];
    }>(
      `SELECT id, status, skipped, warnings_json
         FROM ingestion_runs
        WHERE id <> $1
        ORDER BY id DESC LIMIT 1`,
      [runningId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.skipped).toBe(true);
    expect(Array.isArray(rows[0]!.warnings_json)).toBe(true);
    const warn = rows[0]!.warnings_json[0] as { event?: string };
    expect(warn?.event).toBe("skipped_overlap");
  });

  it("resumes running after the prior row closes out", async () => {
    await pool.query("TRUNCATE ingestion_runs RESTART IDENTITY");
    const priorId = await startRun(pool, { dryRun: false });
    await finishRun(pool, priorId, {
      status: "succeeded",
      source_rows_read: 0,
      rows_dropped_null_b: 0,
      rows_dropped_self_loop: 0,
      rows_dropped_anomaly: 0,
      graph_nodes_written: 0,
      graph_edges_written: 0,
      sites_loaded: 0,
      services_loaded: 0,
      terminate_edges: 0,
      located_at_edges: 0,
      protected_by_edges: 0,
      warnings: [],
    });

    let ran = false;
    const outcome = await tickCron(pool, async () => {
      ran = true;
    });
    expect(outcome.action).toBe("ran");
    expect(ran).toBe(true);
  });

  it("surfaces but does not rethrow errors from the runFn", async () => {
    await pool.query("TRUNCATE ingestion_runs RESTART IDENTITY");
    const outcome = await tickCron(pool, async () => {
      throw new Error("source unreachable");
    });
    expect(outcome.action).toBe("errored");
    if (outcome.action === "errored") {
      expect(outcome.error).toBe("source unreachable");
    }
  });
});

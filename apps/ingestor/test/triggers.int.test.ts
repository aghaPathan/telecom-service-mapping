import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import pg from "pg";
import { migrate } from "@tsm/db";
import { claimNextTrigger, attachRunToTrigger } from "../src/triggers.ts";

const { Pool } = pg;

describe("ingestion_triggers queue", () => {
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
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES
       ('00000000-0000-0000-0000-000000000001', 'a@b.c', 'x', 'admin')`,
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await appPg?.stop();
  }, 30_000);

  describe("claimNextTrigger", () => {
    it("returns null when no unclaimed triggers", async () => {
      await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
      const got = await claimNextTrigger(pool);
      expect(got).toBeNull();
    });

    it("claims the oldest unclaimed trigger atomically", async () => {
      await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
      await pool.query(
        `INSERT INTO ingestion_triggers (requested_by) VALUES
         ('00000000-0000-0000-0000-000000000001'),
         ('00000000-0000-0000-0000-000000000001')`,
      );
      const first = await claimNextTrigger(pool);
      expect(first?.id).toBe(1);
      const second = await claimNextTrigger(pool);
      expect(second?.id).toBe(2);
      const third = await claimNextTrigger(pool);
      expect(third).toBeNull();
    });

    it("attachRunToTrigger writes the run_id", async () => {
      await pool.query(
        `TRUNCATE ingestion_triggers, ingestion_runs RESTART IDENTITY CASCADE`,
      );
      await pool.query(
        `INSERT INTO ingestion_triggers (requested_by) VALUES
         ('00000000-0000-0000-0000-000000000001')`,
      );
      // Seed run id=42 so the FK on ingestion_triggers.run_id resolves.
      await pool.query(
        `INSERT INTO ingestion_runs (id, status) VALUES (42, 'running')`,
      );
      const t = await claimNextTrigger(pool);
      expect(t).not.toBeNull();
      await attachRunToTrigger(pool, t!.id, 42);
      const { rows } = await pool.query(
        `SELECT run_id FROM ingestion_triggers WHERE id=$1`,
        [t!.id],
      );
      expect(rows[0].run_id).toBe("42");
    });
  });
});

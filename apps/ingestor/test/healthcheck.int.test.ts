import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { spawn } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { migrate } from "@tsm/db";

const { Pool } = pg;

// Resolve the compiled script path — `pnpm --filter ingestor build` must have
// been run before this test (CI does this as part of `pnpm -r build`; locally
// the test triggers a one-shot build in beforeAll to keep things self-contained).
const scriptPath = path.resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "dist",
  "scripts",
  "healthcheck.js",
);

function runHealthcheck(databaseUrl: string | undefined): Promise<{
  code: number;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (databaseUrl === undefined) delete env.DATABASE_URL;
    else env.DATABASE_URL = databaseUrl;
    const child = spawn(process.execPath, [scriptPath], { env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe("healthcheck script (dist/scripts/healthcheck.js)", () => {
  let appPg: StartedTestContainer;
  let pool: pg.Pool;
  let databaseUrl: string;

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

    databaseUrl = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(
      5432,
    )}/app`;
    await migrate(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await appPg?.stop();
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE ingestion_triggers RESTART IDENTITY`);
    await pool.query(`TRUNCATE ingestion_runs RESTART IDENTITY CASCADE`);
  });

  it("exit 0 when no runs exist (fresh install, don't flap)", async () => {
    const r = await runHealthcheck(databaseUrl);
    expect(r.code).toBe(0);
  });

  it("exit 0 when last run is succeeded", async () => {
    await pool.query(
      `INSERT INTO ingestion_runs (status, dry_run, finished_at)
       VALUES ('succeeded', false, now())`,
    );
    const r = await runHealthcheck(databaseUrl);
    expect(r.code).toBe(0);
  });

  it("exit 0 when last run is running (in-flight)", async () => {
    await pool.query(
      `INSERT INTO ingestion_runs (status, dry_run) VALUES ('running', false)`,
    );
    const r = await runHealthcheck(databaseUrl);
    expect(r.code).toBe(0);
  });

  it("exit 1 when a running run is stuck >2h (hung detection)", async () => {
    await pool.query(
      `INSERT INTO ingestion_runs (status, dry_run, started_at)
       VALUES ('running', false, now() - interval '3 hours')`,
    );
    const r = await runHealthcheck(databaseUrl);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/stuck in 'running'/);
  });

  it("exit 1 when last run is failed", async () => {
    await pool.query(
      `INSERT INTO ingestion_runs (status, dry_run, finished_at, error_text)
       VALUES ('failed', false, now(), 'boom')`,
    );
    const r = await runHealthcheck(databaseUrl);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/last status=failed/);
  });

  it("exit 1 when DATABASE_URL is unreachable", async () => {
    const r = await runHealthcheck(
      "postgres://app:app@127.0.0.1:1/nonexistent",
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unhealthy/);
  });
});

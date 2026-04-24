import pg from "pg";

const { Pool } = pg;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    max: 1,
  });
  // A `running` row that's older than this is presumed hung — otherwise a
  // stuck Neo4j write would keep the container marked healthy forever.
  // Generous default; nightly cron should take minutes, not hours.
  const RUNNING_MAX_MS = 2 * 60 * 60 * 1000;
  try {
    const { rows } = await pool.query<{ status: string; started_at: string }>(
      `SELECT status, started_at FROM ingestion_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const row = rows[0];
    const status = row?.status;
    if (!status || status === "succeeded") {
      process.exit(0);
    }
    if (status === "running") {
      const startedMs = new Date(row!.started_at).getTime();
      if (Number.isFinite(startedMs) && Date.now() - startedMs < RUNNING_MAX_MS) {
        process.exit(0);
      }
      process.stderr.write(
        `unhealthy: run stuck in 'running' since ${row!.started_at}\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`unhealthy: last status=${status}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `unhealthy: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  } finally {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  }
}

void main();

import pg from "pg";

const { Pool } = pg;

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    max: 1,
  });
  try {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM ingestion_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const status = rows[0]?.status;
    if (!status || status === "succeeded" || status === "running") {
      process.exit(0);
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

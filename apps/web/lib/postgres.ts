import { Pool } from "pg";

let pool: Pool | null = null;

/**
 * Lazy pool. We intentionally do NOT throw on missing DATABASE_URL here —
 * `next build`'s "Collecting page data" step evaluates every route module
 * (including `/api/auth/[...nextauth]`), which constructs the Auth.js adapter
 * at module load. Throwing during that phase breaks `docker compose build`
 * when the image is built without runtime env. `pg.Pool` with an undefined
 * connectionString will not open a connection until a query runs; connection
 * errors surface then with a clearer context.
 */
export function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}

/** Close the singleton pool and reset it. Used by integration tests between
 *  testcontainer lifecycles — not called by the running server. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function pingPostgres(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const started = Date.now();
  try {
    const client = await getPool().connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
    return { ok: true, latency_ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

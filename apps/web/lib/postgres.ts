import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  pool = new Pool({ connectionString: url, max: 5 });
  return pool;
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

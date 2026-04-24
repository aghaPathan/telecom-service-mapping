import type { Pool } from "pg";

export type ClaimedTrigger = { id: number; requested_by: string };

export async function claimNextTrigger(
  pool: Pool,
): Promise<ClaimedTrigger | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query<{ id: string; requested_by: string }>(
      `SELECT id, requested_by FROM ingestion_triggers
         WHERE claimed_at IS NULL
         ORDER BY requested_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
    );
    if (sel.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = sel.rows[0]!;
    await client.query(
      `UPDATE ingestion_triggers SET claimed_at = now() WHERE id = $1`,
      [row.id],
    );
    await client.query("COMMIT");
    return { id: Number(row.id), requested_by: row.requested_by };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function attachRunToTrigger(
  pool: Pool,
  triggerId: number,
  runId: number,
): Promise<void> {
  await pool.query(
    `UPDATE ingestion_triggers SET run_id = $2 WHERE id = $1`,
    [triggerId, runId],
  );
}

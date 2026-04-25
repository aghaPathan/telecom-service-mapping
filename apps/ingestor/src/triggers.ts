import type { Pool } from "pg";

export type TriggerFlavor = "full" | "isis_cost";

export type ClaimedTrigger = {
  id: number;
  requested_by: string;
  flavor: TriggerFlavor;
};

function coerceFlavor(raw: string): TriggerFlavor {
  if (raw === "full" || raw === "isis_cost") return raw;
  // CHECK constraint guarantees this branch is unreachable; defensive fallback.
  throw new Error(`unexpected ingestion_triggers.flavor: ${raw}`);
}

export async function claimNextTrigger(
  pool: Pool,
): Promise<ClaimedTrigger | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sel = await client.query<{
      id: string;
      requested_by: string;
      flavor: string;
    }>(
      `SELECT id, requested_by, flavor FROM ingestion_triggers
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
    return {
      id: Number(row.id),
      requested_by: row.requested_by,
      flavor: coerceFlavor(row.flavor),
    };
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

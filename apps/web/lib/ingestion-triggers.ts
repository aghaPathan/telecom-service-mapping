import { getPool } from "@/lib/postgres";

export async function createTrigger(userId: string): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ingestion_triggers (requested_by) VALUES ($1) RETURNING id`,
    [userId],
  );
  return Number(rows[0]!.id);
}

export type TriggerStatus = {
  trigger_id: number;
  run_id: number | null;
  status: "pending" | "running" | "succeeded" | "failed";
};

export async function getTriggerStatus(
  triggerId: number,
): Promise<TriggerStatus | null> {
  const { rows } = await getPool().query<{
    id: string;
    run_id: string | null;
    run_status: string | null;
  }>(
    `SELECT t.id, t.run_id, r.status AS run_status
       FROM ingestion_triggers t
       LEFT JOIN ingestion_runs r ON r.id = t.run_id
      WHERE t.id = $1`,
    [triggerId],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    trigger_id: Number(row.id),
    run_id: row.run_id === null ? null : Number(row.run_id),
    status: (row.run_status ?? "pending") as TriggerStatus["status"],
  };
}

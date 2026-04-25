import { getPool } from "@/lib/postgres";
import { type TriggerFlavor } from "@tsm/db";

export { type TriggerFlavor, TRIGGER_FLAVORS, isTriggerFlavor } from "@tsm/db";

export async function createTrigger(
  userId: string,
  flavor: TriggerFlavor = "full",
): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ingestion_triggers (requested_by, flavor) VALUES ($1, $2) RETURNING id`,
    [userId, flavor],
  );
  return Number(rows[0]!.id);
}

const RUN_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

function coerceStatus(raw: string | null): RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as RunStatus)
    : "pending";
}

export type TriggerStatus = {
  trigger_id: number;
  run_id: number | null;
  status: RunStatus;
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
  const runId = row.run_id === null ? null : Number(row.run_id);
  // Orphan case: run_id is set but the run row was deleted (run_status is
  // null despite the LEFT JOIN resolving). Report as `failed` so the
  // polling client exits instead of waiting out its 120s timeout.
  const status: RunStatus =
    runId !== null && row.run_status === null
      ? "failed"
      : coerceStatus(row.run_status);
  return { trigger_id: Number(row.id), run_id: runId, status };
}

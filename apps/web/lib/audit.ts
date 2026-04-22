import { getPool } from "@/lib/postgres";
import { log } from "@/lib/logger";

export async function recordAudit(
  userId: string | null,
  action: string,
  target: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO audit_log (user_id, action, target, metadata_json) VALUES ($1,$2,$3,$4::jsonb)`,
      [userId, action, target, JSON.stringify(metadata)],
    );
  } catch (err) {
    log("error", "audit_write_failed", { action, target, err: err instanceof Error ? err.message : String(err) });
  }
}

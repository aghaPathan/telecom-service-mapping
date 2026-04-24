import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { createTrigger } from "@/lib/ingestion-triggers";

/**
 * Manual ingest trigger — admin-only. Inserts an `ingestion_triggers` row;
 * the ingestor's cron tick (see `apps/ingestor/src/cron.ts`) claims the row
 * on its next firing and writes `ingestion_runs.id` back. Poll `/api/ingestion/run/[id]`
 * to follow the run.
 */
export async function POST() {
  const session = await requireRole("admin");
  const triggerId = await createTrigger(session.user.id);
  await recordAudit(
    session.user.id,
    "ingestion_run_triggered",
    String(triggerId),
    {},
  );
  return NextResponse.json({ trigger_id: triggerId }, { status: 201 });
}

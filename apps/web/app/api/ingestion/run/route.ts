import { NextResponse } from "next/server";
import { z } from "zod";
import { TRIGGER_FLAVORS } from "@tsm/db";
import { requireRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { createTrigger } from "@/lib/ingestion-triggers";

/**
 * Manual ingest trigger — admin-only. Inserts an `ingestion_triggers` row;
 * the ingestor's cron tick (see `apps/ingestor/src/cron.ts`) claims the row
 * on its next firing and writes `ingestion_runs.id` back. Poll
 * `/api/ingestion/run/[id]` to follow the run.
 *
 * Optional JSON body: `{ flavor?: "full" | "isis_cost" }`. Default `"full"`.
 * `requireRole` runs FIRST so viewer/operator get 403 before we parse JSON.
 */
const BodySchema = z.object({
  flavor: z.enum(TRIGGER_FLAVORS).optional(),
});

export async function POST(req?: Request) {
  const session = await requireRole("admin");

  let flavor: "full" | "isis_cost" = "full";
  if (req) {
    // Tolerate empty body / non-JSON content-type — fall back to default.
    let raw: unknown = {};
    try {
      const text = await req.text();
      raw = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_body", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    flavor = parsed.data.flavor ?? "full";
  }

  const triggerId = await createTrigger(session.user.id, flavor);
  await recordAudit(
    session.user.id,
    "ingestion_run_triggered",
    String(triggerId),
    { flavor },
  );
  return NextResponse.json({ trigger_id: triggerId }, { status: 201 });
}

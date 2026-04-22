import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";

/**
 * Manual ingest trigger — admin-only. `requireRole("admin")` redirects
 * anonymous callers to /login (via middleware) and throws a 403 Response
 * for insufficient role. Actual job enqueue is still TODO(#13).
 */
export async function POST() {
  const session = await requireRole("admin");
  await recordAudit(session.user.id, "ingestion_run_triggered", null, {});
  // TODO(#13): actually enqueue a run via trigger row / queue.
  return NextResponse.json({ status: "queued" });
}

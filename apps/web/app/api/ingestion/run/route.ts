import { NextResponse } from "next/server";
import { log } from "@/lib/logger";

/**
 * Manual ingest trigger — admin-only. Auth lands in slice #7 (Auth.js + RBAC);
 * until then this endpoint denies by default so we never ship an unauth'd
 * trigger into an environment that has operator data. Once #7 is in:
 *
 *   1. gate via `requireRole("admin")`
 *   2. enqueue via a shared pg queue or by touching a trigger row the
 *      ingestor polls (the web container can't reach the ingestor process
 *      directly across compose services without an API).
 */
// TODO(#7): replace deny-by-default with `requireRole("admin")`.
export async function POST() {
  log("warn", "ingestion_run_denied", { reason: "auth_not_available" });
  return NextResponse.json(
    {
      error: "forbidden",
      message:
        "Manual trigger requires admin auth (slice #7). Denied by default.",
    },
    { status: 403 },
  );
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parsePathQuery, runPath } from "@/lib/path";
import { tryConsume } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Path-trace — viewer+ access. Given `from=device:<name>` or
 * `from=service:<cid>`, returns the shortest monotonic-level path to a Core
 * device, or a structured `no_path` result describing where the trace stalled.
 * Rate-limited per-user (in-memory token bucket, 20 cap / 2 rps refill), same
 * shape as /api/search.
 */
export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`path:${session.user.id}`, {
    capacity: 20,
    refillPerSec: 2,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }

  const raw = req.nextUrl.searchParams.get("from");
  let parsed;
  try {
    parsed = parsePathQuery({ from: raw });
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  try {
    const result = await runPath(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "path_failed", { error: msg, user: session.user.id });
    return NextResponse.json({ error: "path_failed" }, { status: 503 });
  }
}

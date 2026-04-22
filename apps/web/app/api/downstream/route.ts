import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parseDownstreamQuery, runDownstream } from "@/lib/downstream";
import { tryConsume } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Downstream blast-radius — viewer+ access. Given `device=<name>`, returns
 * every device reachable via :CONNECTS_TO hops where each step strictly
 * increases `level`, grouped by (level, role). Rate-limited per-user
 * (in-memory token bucket, 20 cap / 2 rps refill).
 */
export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`downstream:${session.user.id}`, {
    capacity: 20,
    refillPerSec: 2,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }

  const input = Object.fromEntries(req.nextUrl.searchParams);
  let parsed;
  try {
    parsed = parseDownstreamQuery(input);
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  try {
    const result = await runDownstream(parsed);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "downstream_failed", { error: msg, user: session.user.id });
    return NextResponse.json({ error: "downstream_failed" }, { status: 503 });
  }
}

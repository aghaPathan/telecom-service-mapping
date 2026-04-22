import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parseQuery, runSearch } from "@/lib/search";
import { tryConsume } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Omnibox search — viewer+ access. Resolver cascade:
 * Service.cid → Service.mobily_cid → Device.name → fulltext device name.
 * Rate-limited per-user (in-memory token bucket, 20 cap / 2 rps refill).
 */
export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`search:${session.user.id}`, {
    capacity: 20,
    refillPerSec: 2,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }

  const raw = req.nextUrl.searchParams.get("q");
  let parsed;
  try {
    parsed = parseQuery({ q: raw });
  } catch {
    return NextResponse.json(
      { error: "invalid_query" },
      { status: 400 },
    );
  }

  try {
    const result = await runSearch(parsed.q);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "search_failed", { error: msg, user: session.user.id });
    return NextResponse.json({ error: "search_failed" }, { status: 503 });
  }
}

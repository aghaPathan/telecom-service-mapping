import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parseImpactQuery, runImpact } from "@/lib/impact";
import { tryConsume } from "@/lib/rate-limit";
import { csvRow, sanitizeFilename } from "@/lib/csv";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// NOTE: no HARD_CAP here. The page applies the 10k guard; the CSV endpoint
// intentionally streams the full result for download (that's the fallback).
export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`impact-csv:${session.user.id}`, {
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
    parsed = parseImpactQuery(input);
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  let result;
  try {
    // Pass hardCap: Infinity so the CSV never returns too_large — always
    // returns ok with the full row set.
    result = await runImpact(parsed, { hardCap: Number.POSITIVE_INFINITY });
  } catch (err) {
    log("error", "impact_csv_failed", {
      error: err instanceof Error ? err.message : String(err),
      user: session.user.id,
    });
    return NextResponse.json({ error: "impact_failed" }, { status: 503 });
  }

  if (result.status === "start_not_found") {
    return NextResponse.json({ error: "start_not_found" }, { status: 404 });
  }
  if (result.status === "too_large") {
    // unreachable with hardCap=Infinity but keep the branch for type narrowing
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const header = csvRow(["name", "role", "level", "site", "vendor", "hops"]);
  const body = result.rows
    .map((r) => csvRow([r.name, r.role, r.level, r.site, r.vendor, r.hops]))
    .join("\n");
  const csv = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;

  const filename = `impact-${sanitizeFilename(parsed.device)}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

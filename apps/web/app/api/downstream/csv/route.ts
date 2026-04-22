import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { parseDownstreamQuery, runDownstream } from "@/lib/downstream";
import type { DeviceRef } from "@/lib/path";
import { tryConsume } from "@/lib/rate-limit";
import { csvRow, sanitizeFilename } from "@/lib/csv";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Downstream CSV export — viewer+ access. Same auth/zod as
 * /api/downstream. Returns a text/csv body on success.
 *
 * NOTE: error shapes are JSON (not CSV). A CSV-serving endpoint returning
 * JSON on error is acceptable here — the client opens CSV on 200 only; a
 * 404/400/429/503 surfaces to the browser's fetch/download flow which
 * honors the status code, and a structured JSON envelope is easier to
 * debug than a malformed CSV.
 */
export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`downstream-csv:${session.user.id}`, {
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

  let result;
  try {
    result = await runDownstream(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "downstream_csv_failed", {
      error: msg,
      user: session.user.id,
    });
    return NextResponse.json({ error: "downstream_failed" }, { status: 503 });
  }

  if (result.status === "start_not_found") {
    return NextResponse.json({ error: "start_not_found" }, { status: 404 });
  }

  // Flatten all groups, sort by (level ASC, name ASC).
  const devices: DeviceRef[] = result.groups.flatMap((g) => g.devices);
  devices.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return a.name.localeCompare(b.name);
  });

  const header = csvRow(["name", "role", "level", "site", "domain"]);
  const body = devices
    .map((d) => csvRow([d.name, d.role, d.level, d.site, d.domain]))
    .join("\n");
  const csv = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;

  const filename = `downstream-${sanitizeFilename(parsed.device)}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import {
  parseDeviceListQuery,
  runDeviceList,
  type DeviceListQuery,
  type DeviceListRow,
} from "@/lib/device-list";
import { tryConsume } from "@/lib/rate-limit";
import { csvRow, sanitizeFilename } from "@/lib/csv";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Cap the total rows collected for paginated modes so an accidentally-huge
// role/level query doesn't exhaust memory. 100k rows at ~80 bytes/row ≈ 8MB —
// well within a single response budget but still firmly bounded.
const HARD_CAP = 100_000;
// pageSize the resolver clamps to (see Base.clamp in lib/device-list.ts).
const PAGE_SIZE = 500;

function identFor(q: DeviceListQuery): string {
  if (q.mode === "byRole") return q.role;
  if (q.mode === "byLevel") return `level-${q.level}`;
  if (q.mode === "bySite") return `site-${q.site}`;
  return q.role ? `fanout-${q.role}` : "fanout";
}

export async function GET(req: NextRequest) {
  const session = await requireRole("viewer");
  const rl = tryConsume(`devices-list-csv:${session.user.id}`, {
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
  let parsed: DeviceListQuery;
  try {
    parsed = parseDeviceListQuery(input);
  } catch {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  let rows: DeviceListRow[];
  let truncated = false;
  try {
    if (parsed.mode === "byFanout") {
      const r = await runDeviceList(parsed);
      rows = r.rows;
    } else {
      const all: DeviceListRow[] = [];
      let page = 1;
      // Paginate until we've read `total` rows or hit HARD_CAP.
      // Break on empty page as a belt-and-braces against runaway loops.
      // Spread keeps the discriminated-union shape; TS narrows on `parsed.mode`.
      for (;;) {
        const q: DeviceListQuery =
          parsed.mode === "byRole"
            ? { ...parsed, page, pageSize: PAGE_SIZE }
            : { ...parsed, page, pageSize: PAGE_SIZE };
        const r = await runDeviceList(q);
        if (r.rows.length === 0) break;
        for (const row of r.rows) {
          all.push(row);
          if (all.length >= HARD_CAP) break;
        }
        if (all.length >= HARD_CAP) {
          truncated = true;
          break;
        }
        if (all.length >= r.total) break;
        page += 1;
      }
      rows = all;
    }
  } catch (err) {
    log("error", "devices_list_csv_failed", {
      error: err instanceof Error ? err.message : String(err),
      user: session.user.id,
      mode: parsed.mode,
    });
    return NextResponse.json({ error: "devices_list_failed" }, { status: 503 });
  }

  if (truncated) {
    log("warn", "devices_list_csv_truncated", {
      user: session.user.id,
      mode: parsed.mode,
      cap: HARD_CAP,
    });
  }

  const includeFanout = parsed.mode === "byFanout";
  const header = includeFanout
    ? csvRow(["name", "role", "level", "site", "vendor", "fanout"])
    : csvRow(["name", "role", "level", "site", "vendor"]);
  const body = rows
    .map((r) =>
      includeFanout
        ? csvRow([r.name, r.role, r.level, r.site, r.vendor, r.fanout ?? 0])
        : csvRow([r.name, r.role, r.level, r.site, r.vendor]),
    )
    .join("\n");
  const csv = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;

  const filename = `devices-${parsed.mode}-${sanitizeFilename(identFor(parsed))}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
